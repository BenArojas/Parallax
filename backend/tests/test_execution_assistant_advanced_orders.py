from fastapi import FastAPI
from fastapi.testclient import TestClient

from deps import get_tws_adapter, get_tws_live_policy
from models.tws_execution_assistant import TwsOrderPackageRequest
from routers.execution_assistant import router as ea_router
from services.tws_live_policy import TwsLivePolicyService
from services.tws_order_packages import preview_order_package


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(ea_router)
    return TestClient(app)


def _scale_out_request(**overrides) -> dict:
    base = {
        "kind": "scale_out_ladder",
        "conid": 270639,
        "symbol": "INTC",
        "side": "BUY",
        "quantity": 20,
        "order_type": "LMT",
        "limit_price": 120,
        "lots": [
            {"quantity": 5, "target_price": 125, "stop_price": 118},
            {"quantity": 5, "target_price": 130, "stop_price": 118},
            {"quantity": 10, "target_price": 135, "trail": {"mode": "amount", "value": 2}},
        ],
    }
    base.update(overrides)
    return base


def test_scale_out_preview_rejects_lot_quantities_that_dont_sum_to_entry():
    client = _client()
    req = _scale_out_request(lots=[
        {"quantity": 5, "target_price": 125, "stop_price": 118},
        {"quantity": 5, "target_price": 130, "stop_price": 118},
        {"quantity": 8, "target_price": 135, "trail": {"mode": "amount", "value": 2}},
    ])

    r = client.post("/execution-assistant/order-packages/preview", json=req)

    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "invalid_order_package"
    assert any("sum exactly" in e for e in r.json()["detail"]["errors"])


# ── Task 2: Live Place Path ──────────────────────────────────────────────────

class _PackageAdapterStub:
    """Connected to a live (non-paper) port, nothing allowlisted or armed."""

    def __init__(self) -> None:
        self.place_order_package_calls = 0

    def is_connected(self) -> bool:
        return True

    def is_paper_port(self) -> bool:
        return False

    def is_kill_switch_active(self) -> bool:
        return False

    def connected_account_id(self) -> str | None:
        return "U12345"

    def connected_host(self) -> str:
        return "127.0.0.1"

    def connected_port(self) -> int | None:
        return 7496

    async def place_order_package(self, preview, *, mode, live_policy=None, advanced_override=None):
        self.place_order_package_calls += 1
        raise AssertionError("adapter.place_order_package should not be called")


def test_place_live_package_fails_closed_when_not_armed():
    adapter = _PackageAdapterStub()
    app = FastAPI()
    app.include_router(ea_router)
    app.dependency_overrides[get_tws_adapter] = lambda: adapter
    app.dependency_overrides[get_tws_live_policy] = lambda: TwsLivePolicyService()
    client = TestClient(app)

    preview = preview_order_package(TwsOrderPackageRequest(**_scale_out_request()))

    r = client.post("/execution-assistant/order-packages/place-live", json=preview.model_dump())

    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "live_session_not_allowlisted"
    assert adapter.place_order_package_calls == 0
