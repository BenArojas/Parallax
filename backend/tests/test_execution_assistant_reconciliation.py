"""
Public-boundary test for GET /execution-assistant/reconciliation.

Critical promise: Orbit does not silently claim orders it did not create —
unmanaged orders must be correctly identified and surfaced at the API boundary.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from deps import get_tws_adapter
from routers.execution_assistant import router as ea_router
from models.tws_execution_assistant import (
    OrderSnapshot,
    PositionSnapshot,
    ReconciliationSnapshot,
)
from services.tws_order_packages import derive_package_warnings


class _AdapterStub:
    def get_reconciliation(self) -> ReconciliationSnapshot:
        return ReconciliationSnapshot(
            position_count=1,
            open_order_count=2,
            unmanaged_order_count=1,
            positions=[
                PositionSnapshot(conid=265598, symbol="AAPL", position=10.0, avg_cost=150.0),
            ],
            open_orders=[
                OrderSnapshot(
                    order_id=1,
                    conid=265598,
                    symbol="AAPL",
                    side="BUY",
                    quantity=5.0,
                    order_type="LMT",
                    lmt_price=180.0,
                    status="Submitted",
                    is_unmanaged=False,
                ),
                OrderSnapshot(
                    order_id=2,
                    conid=265598,
                    symbol="AAPL",
                    side="SELL",
                    quantity=3.0,
                    order_type="MKT",
                    lmt_price=None,
                    status="Submitted",
                    is_unmanaged=True,
                ),
            ],
        )


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(ea_router)
    app.dependency_overrides[get_tws_adapter] = lambda: _AdapterStub()
    return TestClient(app)


def test_reconciliation_returns_positions_and_orders():
    r = _client().get("/execution-assistant/reconciliation")
    assert r.status_code == 200
    body = r.json()
    assert body["position_count"] == 1
    assert body["open_order_count"] == 2
    assert len(body["positions"]) == 1
    assert len(body["open_orders"]) == 2


def test_unmanaged_orders_are_flagged():
    """Orders not created by Orbit must be marked is_unmanaged=true."""
    r = _client().get("/execution-assistant/reconciliation")
    orders = r.json()["open_orders"]
    unmanaged = [o for o in orders if o["is_unmanaged"]]
    managed = [o for o in orders if not o["is_unmanaged"]]
    assert len(unmanaged) == 1
    assert len(managed) == 1
    assert r.json()["unmanaged_order_count"] == 1


def test_lmt_price_is_null_for_market_orders():
    r = _client().get("/execution-assistant/reconciliation")
    mkt_order = next(o for o in r.json()["open_orders"] if o["order_type"] == "MKT")
    assert mkt_order["lmt_price"] is None


# ── Task 3: Package Reconciliation Warnings ──────────────────────────────────

def test_reconciliation_flags_scale_out_lots_sharing_one_parent():
    """Regression test for the shared-parent bug: two lots' exits sharing one
    parentId must surface as a package_warning at the API boundary, not silently
    reconcile clean."""
    open_orders = [
        OrderSnapshot(
            order_id=121, conid=270639, symbol="INTC", side="BUY", quantity=20.0,
            order_type="LMT", lmt_price=120.0, status="PreSubmitted", is_unmanaged=False,
            parent_id=None, oca_group=None, order_ref="ORBIT:TWS:pkg-1:entry",
        ),
        OrderSnapshot(
            order_id=122, conid=270639, symbol="INTC", side="SELL", quantity=5.0,
            order_type="LMT", lmt_price=125.0, status="PreSubmitted", is_unmanaged=False,
            parent_id=121, oca_group="LOT0", order_ref="ORBIT:TWS:pkg-1:lot0_target",
        ),
        OrderSnapshot(
            order_id=123, conid=270639, symbol="INTC", side="SELL", quantity=5.0,
            order_type="LMT", lmt_price=130.0, status="PreSubmitted", is_unmanaged=False,
            parent_id=121, oca_group="LOT1", order_ref="ORBIT:TWS:pkg-1:lot1_target",
        ),
    ]
    positions = [PositionSnapshot(conid=270639, symbol="INTC", position=20.0, avg_cost=120.0)]

    class _UnsafeShapeAdapterStub:
        def get_reconciliation(self) -> ReconciliationSnapshot:
            return ReconciliationSnapshot(
                position_count=len(positions),
                open_order_count=len(open_orders),
                unmanaged_order_count=0,
                positions=positions,
                open_orders=open_orders,
                package_warnings=derive_package_warnings(open_orders, positions),
            )

    app = FastAPI()
    app.include_router(ea_router)
    app.dependency_overrides[get_tws_adapter] = lambda: _UnsafeShapeAdapterStub()
    client = TestClient(app)

    r = client.get("/execution-assistant/reconciliation")

    assert r.status_code == 200
    kinds = {w["kind"] for w in r.json()["package_warnings"]}
    assert "cross_lot_parent_id" in kinds


def test_derive_package_warnings_sell_exposure_respects_oca_grouping_and_existing_shorts():
    """Sanity check for the sell-exposure rule's two subtle parts in one pass:
    (1) lot0's target+stop share one OCA group and must count once (15), not
    twice (30) — isolated lots still sum to 30 > the 20-share long position, so
    that must warn; (2) a pre-existing short position (accepted elsewhere via
    explicit confirmation) must never trigger this long-position-only check."""
    open_orders = [
        OrderSnapshot(
            order_id=1, conid=270639, symbol="INTC", side="SELL", quantity=15.0,
            order_type="LMT", status="PreSubmitted", is_unmanaged=False,
            parent_id=100, oca_group="LOT0", order_ref="ORBIT:TWS:pkg:lot0_target",
        ),
        OrderSnapshot(
            order_id=2, conid=270639, symbol="INTC", side="SELL", quantity=15.0,
            order_type="STP", status="PreSubmitted", is_unmanaged=False,
            parent_id=100, oca_group="LOT0", order_ref="ORBIT:TWS:pkg:lot0_stop",
        ),
        OrderSnapshot(
            order_id=3, conid=270639, symbol="INTC", side="SELL", quantity=15.0,
            order_type="LMT", status="PreSubmitted", is_unmanaged=False,
            parent_id=200, oca_group="LOT1", order_ref="ORBIT:TWS:pkg:lot1_target",
        ),
        OrderSnapshot(
            order_id=4, conid=999, symbol="MXL", side="SELL", quantity=5.0,
            order_type="LMT", status="PreSubmitted", is_unmanaged=True,
        ),
    ]
    positions = [
        PositionSnapshot(conid=270639, symbol="INTC", position=20.0, avg_cost=120.0),
        PositionSnapshot(conid=999, symbol="MXL", position=-1.0, avg_cost=96.8),
    ]

    warnings = derive_package_warnings(open_orders, positions)

    exposure_warnings = [w for w in warnings if w.kind == "sell_exposure_exceeds_position"]
    assert len(exposure_warnings) == 1  # only INTC — MXL's existing short never triggers this check
    assert exposure_warnings[0].conid == 270639
    assert "30" in exposure_warnings[0].message and "20" in exposure_warnings[0].message
