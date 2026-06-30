from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.execution_assistant import router as ea_router


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
