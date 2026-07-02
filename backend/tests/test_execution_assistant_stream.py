from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketState

from models.tws_execution_assistant import TwsStreamSubscribeRequest
from routers.tws_stream import router as tws_stream_router
from services.tws_broker_adapter import TwsBrokerAdapter


class _CallableEvent:
    def __init__(self) -> None:
        self._handlers: list[object] = []

    def __iadd__(self, handler: object):
        self._handlers.append(handler)
        return self

    def __isub__(self, handler: object):
        self._handlers.remove(handler)
        return self

    def emit(self, *args: object) -> None:
        for handler in self._handlers:
            handler(*args)


def test_get_quote_maps_10090_to_partial():
    from ib_async import Contract as IbContract, Ticker

    class _FakeIB:
        def __init__(self, code: int, message: str) -> None:
            self.errorEvent = _CallableEvent()
            self._code = code
            self._message = message

        def isConnected(self) -> bool:
            return True

        def reqMarketDataType(self, _mdt: int) -> None:
            pass

        async def reqTickersAsync(self, *contracts):
            self.errorEvent.emit(
                1,
                self._code,
                self._message,
                contracts[0] if contracts else None,
            )
            return [Ticker(contract=contracts[0] if contracts else IbContract())]

        def cancelMktData(self, _contract: object) -> None:
            pass

    adapter = TwsBrokerAdapter()
    adapter._ib = _FakeIB(10090, "Part of requested market data is not subscribed.")  # type: ignore[assignment]
    adapter._state = "connected"

    result = asyncio.run(adapter.get_quote(123))

    assert result.market_data_type == "partial"
    assert result.error_code == 10090
    assert result.unavailable_reason == "Partial market data subscription — some fields may be missing."
    assert result.is_delayed is False

    # 10197: another IBKR session (paper borrows its live user's market data) is holding it.
    adapter._ib = _FakeIB(10197, "No market data during competing live session")  # type: ignore[assignment]
    result_10197 = asyncio.run(adapter.get_quote(123))
    assert result_10197.market_data_type == "unavailable" and "log out" in (result_10197.unavailable_reason or "").lower()


def test_stream_quote_prefers_ticker_data_over_10089_warning():
    class _FakeTicker:
        def __init__(self, contract: object) -> None:
            self.contract = contract
            self.updateEvent = _CallableEvent()
            self.last = None
            self.bid = None
            self.ask = None
            self.bidSize = None
            self.askSize = None
            self.high = None
            self.low = None
            self.volume = None
            self.marketDataType = 0

    class _FakeIB:
        def __init__(self) -> None:
            self.errorEvent = _CallableEvent()
            self.tickers: dict[int, _FakeTicker] = {}

        def isConnected(self) -> bool:
            return True

        def reqMarketDataType(self, _mdt: int) -> None:
            pass

        def reqMktData(self, contract: object, snapshot: bool = False):
            assert snapshot is False
            ticker = _FakeTicker(contract)
            self.tickers[contract.conId] = ticker
            return ticker

        def cancelMktData(self, _contract: object) -> None:
            pass

    class _WebSocketStub:
        def __init__(self) -> None:
            self.sent: list[dict[str, object]] = []
            self.client_state = WebSocketState.CONNECTED
            self.application_state = WebSocketState.CONNECTED

        async def send_json(self, payload: dict[str, object]) -> None:
            self.sent.append(payload)

    adapter = TwsBrokerAdapter()
    adapter._ib = _FakeIB()  # type: ignore[assignment]
    adapter._state = "connected"
    websocket = _WebSocketStub()

    async def _exercise() -> None:
        await adapter.stream_subscribe(
            websocket,  # type: ignore[arg-type]
            TwsStreamSubscribeRequest(action="subscribe", channel="quote", conid=123),
        )
        adapter._ib.errorEvent.emit(1, 10089, "warning", SimpleNamespace(conId=123))
        ticker = adapter._ib.tickers[123]
        ticker.last = 101.25
        ticker.marketDataType = 3
        ticker.updateEvent.emit(ticker)
        await asyncio.sleep(0)

        await adapter.stream_subscribe(
            websocket,  # type: ignore[arg-type]
            TwsStreamSubscribeRequest(action="subscribe", channel="quote", conid=456),
        )
        adapter._ib.errorEvent.emit(2, 10089, "warning", SimpleNamespace(conId=456))
        adapter._ib.tickers[456].updateEvent.emit(adapter._ib.tickers[456])
        await asyncio.sleep(0)

    asyncio.run(_exercise())

    assert websocket.sent[0]["conid"] == 123
    assert websocket.sent[0]["entitlement"] == "delayed"
    assert websocket.sent[0]["unavailable_reason"] is None
    assert websocket.sent[1]["conid"] == 456
    assert websocket.sent[1]["entitlement"] == "unavailable"
    assert websocket.sent[1]["unavailable_reason"] == "API market data subscription required; delayed market data may be available."


def test_stream_depth_emits_levels_and_unavailable_on_error():
    from ib_async.objects import DOMLevel

    class _FakeTicker:
        def __init__(self, contract: object) -> None:
            self.contract = contract
            self.updateEvent = _CallableEvent()
            self.domBids: list[DOMLevel] = []
            self.domAsks: list[DOMLevel] = []

    class _FakeIB:
        def __init__(self) -> None:
            self.errorEvent = _CallableEvent()
            self.tickers: dict[int, _FakeTicker] = {}
            self.cancelled: list[object] = []

        def isConnected(self) -> bool:
            return True

        def reqMktDepth(self, contract: object, numRows: int = 5):
            ticker = _FakeTicker(contract)
            self.tickers[contract.conId] = ticker
            return ticker

        def cancelMktDepth(self, contract: object, isSmartDepth: bool = False) -> None:
            self.cancelled.append(contract)

    class _WebSocketStub:
        def __init__(self) -> None:
            self.sent: list[dict[str, object]] = []
            self.client_state = WebSocketState.CONNECTED
            self.application_state = WebSocketState.CONNECTED

        async def send_json(self, payload: dict[str, object]) -> None:
            self.sent.append(payload)

    adapter = TwsBrokerAdapter()
    adapter._ib = _FakeIB()  # type: ignore[assignment]
    adapter._state = "connected"
    websocket = _WebSocketStub()

    async def _exercise() -> None:
        await adapter.stream_subscribe(
            websocket,  # type: ignore[arg-type]
            TwsStreamSubscribeRequest(action="subscribe", channel="depth", conid=123),
        )
        ticker = adapter._ib.tickers[123]

        # Happy path: real levels flow through as entitlement="live".
        ticker.domBids = [DOMLevel(price=99.5, size=200, marketMaker="ARCA")]
        ticker.domAsks = [DOMLevel(price=99.6, size=150, marketMaker="NSDQ")]
        ticker.updateEvent.emit(ticker)
        await asyncio.sleep(0)

        # Unavailable path: a depth-permission error (e.g. 10092) never raises —
        # it only arrives via IB.errorEvent, scoped to this conid.
        adapter._ib.errorEvent.emit(2, 10092, "Deep market data is not supported for this contract.", SimpleNamespace(conId=123))
        await asyncio.sleep(0)

    asyncio.run(_exercise())

    assert websocket.sent[0]["entitlement"] == "live"
    assert websocket.sent[0]["bids"] == [{"price": 99.5, "size": 200, "market_maker": "ARCA"}]
    assert websocket.sent[0]["asks"] == [{"price": 99.6, "size": 150, "market_maker": "NSDQ"}]

    assert websocket.sent[1]["entitlement"] == "unavailable"
    assert websocket.sent[1]["bids"] == []
    assert websocket.sent[1]["asks"] == []
    assert websocket.sent[1]["unavailable_reason"] == "Deep market data is not supported for this contract."


class _StreamAdapterStub:
    def __init__(self) -> None:
        self.cleaned_up = False
        self.last_request: dict[str, object] | None = None

    def is_connected(self) -> bool:
        return False

    def stream_register_socket(self, websocket) -> None:
        return None

    async def stream_subscribe(self, websocket, req) -> None:
        self.last_request = {"action": req.action, "channel": req.channel, "conid": req.conid, "timeframe": req.timeframe}

    async def stream_unsubscribe(self, websocket, req) -> None:
        self.last_request = {"action": req.action, "channel": req.channel, "conid": req.conid, "timeframe": req.timeframe}

    def stream_cleanup(self, websocket) -> None:
        self.cleaned_up = True


def test_tws_stream_sends_initial_status_typed_error_and_cleans_up():
    app = FastAPI()
    adapter = _StreamAdapterStub()
    app.state.tws_adapter = adapter
    app.include_router(tws_stream_router)

    with TestClient(app) as client:
        with client.websocket_connect("/execution-assistant/ws") as websocket:
            assert websocket.receive_json() == {
                "type": "tws_stream_status",
                "connected": False,
            }

            websocket.send_text("{bad json")
            error = websocket.receive_json()
            assert error["type"] == "tws_stream_error"
            assert isinstance(error["message"], str)

    assert adapter.cleaned_up is True
