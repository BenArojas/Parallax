from __future__ import annotations

import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient

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
        def __init__(self) -> None:
            self.errorEvent = _CallableEvent()

        def isConnected(self) -> bool:
            return True

        def reqMarketDataType(self, _mdt: int) -> None:
            pass

        async def reqTickersAsync(self, *contracts):
            self.errorEvent.emit(
                1,
                10090,
                "Part of requested market data is not subscribed.",
                contracts[0] if contracts else None,
            )
            return [Ticker(contract=contracts[0] if contracts else IbContract())]

        def cancelMktData(self, _contract: object) -> None:
            pass

    adapter = TwsBrokerAdapter()
    adapter._ib = _FakeIB()  # type: ignore[assignment]
    adapter._state = "connected"

    result = asyncio.run(adapter.get_quote(123))

    assert result.market_data_type == "partial"
    assert result.error_code == 10090
    assert result.unavailable_reason == "Partial market data subscription — some fields may be missing."
    assert result.is_delayed is False


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
