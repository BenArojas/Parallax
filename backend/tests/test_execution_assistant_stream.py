from __future__ import annotations

import asyncio

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
