from fastapi import FastAPI
from fastapi.testclient import TestClient

from deps import get_tws_adapter, get_tws_live_policy
from routers.execution_assistant import router as ea_router
from services.tws_live_policy import TwsLivePolicyService


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

    r = client.post("/execution-assistant/order-packages/place-live", json=_scale_out_request())

    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "live_session_not_allowlisted"
    assert adapter.place_order_package_calls == 0


def test_place_paper_package_revalidates_lot_quantities_at_submit_time():
    """Regression test: submit must rebuild the order graph from the request and
    re-run validation, not trust a client-supplied leg list. A forged submission
    with mismatched lot quantities must still fail before any broker call."""
    adapter = _PackageAdapterStub()
    app = FastAPI()
    app.include_router(ea_router)
    app.dependency_overrides[get_tws_adapter] = lambda: adapter
    client = TestClient(app)
    req = _scale_out_request(lots=[
        {"quantity": 5, "target_price": 125, "stop_price": 118},
        {"quantity": 5, "target_price": 130, "stop_price": 118},
        {"quantity": 8, "target_price": 135, "trail": {"mode": "amount", "value": 2}},
    ])

    r = client.post("/execution-assistant/order-packages/place-paper", json=req)

    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "invalid_order_package"
    assert adapter.place_order_package_calls == 0


# ── Repair: isolate each lot under its own parent ────────────────────────────
#
# Paper testing against a real TWS account proved a single shared parent entry
# is unsafe: TWS auto-links every order sharing one parentId into one
# OCA-managed cohort regardless of any custom ocaGroup string, which collapsed
# all lots' exits into one group and normalized every exit's quantity to the
# parent's full size. Each lot must get its own parent entry, sized to that lot.

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

from models.tws_execution_assistant import TwsModifyOrderRequest, TwsOrderPackageRequest
from services.tws_broker_adapter import TwsBrokerAdapter, TwsPlaceOrderGuardError
from services.tws_order_packages import preview_order_package


def test_scale_out_preview_creates_one_entry_parent_per_lot():
    client = _client()
    req = _scale_out_request()

    r = client.post("/execution-assistant/order-packages/preview", json=req)

    assert r.status_code == 200
    legs = r.json()["legs"]
    entry_legs = {leg["role"]: leg for leg in legs if leg["parent_ref"] is None}

    assert len(entry_legs) == len(req["lots"])  # one parent per lot, not one shared parent
    for i, lot in enumerate(req["lots"]):
        entry_role = f"lot{i}_entry"
        assert entry_role in entry_legs
        assert entry_legs[entry_role]["quantity"] == lot["quantity"]  # sized to its own lot, not the combined total
        exits = [leg for leg in legs if leg["role"].startswith(f"lot{i}_") and leg["parent_ref"] is not None]
        assert len(exits) == 3  # target + stop-or-trail + moc fallback
        assert all(leg["parent_ref"] == entry_role for leg in exits)  # never another lot's entry


def test_place_order_package_isolates_each_lot_under_its_own_parent():
    """Adapter-level regression test using a fake IB client: proves the actual
    broker order graph keeps each lot's exits under that lot's own parentId and
    OCA group, with no cross-lot sharing — the property the unsafe shared-parent
    design violated against a real paper account."""
    req = TwsOrderPackageRequest(**_scale_out_request())
    preview = preview_order_package(req)

    adapter = TwsBrokerAdapter()
    adapter._state = "connected"
    adapter._connected_port = 4002  # paper port

    placed = []

    class _FakeTrade:
        def __init__(self, order):
            self.order = order
            self.orderStatus = SimpleNamespace(status="PreSubmitted")

    class _FakeEvent:
        def __iadd__(self, fn):
            return self

        def __isub__(self, fn):
            return self

    fake_ib = MagicMock()
    fake_ib.isConnected.return_value = True
    fake_ib.client.getReqId.side_effect = iter(range(1, 100))
    fake_ib.errorEvent = _FakeEvent()
    fake_ib.placeOrder.side_effect = lambda contract, order: placed.append(order) or _FakeTrade(order)
    adapter._ib = fake_ib

    asyncio.run(adapter.place_order_package(preview, mode="paper"))

    by_role = {o.orderRef.rsplit(":", 1)[-1]: o for o in placed}
    entry_ids = {role: o.orderId for role, o in by_role.items() if role.endswith("_entry")}
    assert len(entry_ids) == len(req.lots)

    oca_groups = []
    for i in range(len(req.lots)):
        entry_role = f"lot{i}_entry"
        exit_roles = [r for r in by_role if r.startswith(f"lot{i}_") and not r.endswith("_entry")]
        assert exit_roles
        for role in exit_roles:
            assert by_role[role].parentId == entry_ids[entry_role]  # only this lot's own parent
            other_parent_ids = {pid for r, pid in entry_ids.items() if r != entry_role}
            assert by_role[role].parentId not in other_parent_ids  # never another lot's parent
            oca_groups.append(by_role[role].ocaGroup)

    assert len(set(oca_groups)) == len(req.lots)  # each lot's OCA group is distinct, none shared


# ── Task 4: Bracket Packages ──────────────────────────────────────────────────

def _bracket_request(**overrides) -> dict:
    base = {
        "kind": "bracket",
        "conid": 270639,
        "symbol": "INTC",
        "side": "BUY",
        "quantity": 100,
        "order_type": "LMT",
        "limit_price": 120,
        "target_price": 125,
        "stop_price": 115,
    }
    base.update(overrides)
    return base


def test_bracket_preview_has_parent_target_stop_and_final_transmit():
    """A bracket is one shared parent with two children — not scale-out's
    per-lot parent isolation, since a bracket is exactly one lot."""
    client = _client()
    req = _bracket_request()

    r = client.post("/execution-assistant/order-packages/preview", json=req)

    assert r.status_code == 200
    by_role = {leg["role"]: leg for leg in r.json()["legs"]}

    assert set(by_role) == {"parent", "target", "stop"}
    assert by_role["parent"]["parent_ref"] is None
    assert by_role["parent"]["side"] == "BUY"
    assert by_role["parent"]["transmit"] is False
    assert by_role["target"]["parent_ref"] == "parent"
    assert by_role["target"]["side"] == "SELL"  # opposite of the BUY entry
    assert by_role["target"]["transmit"] is False
    assert by_role["stop"]["parent_ref"] == "parent"
    assert by_role["stop"]["side"] == "SELL"
    assert by_role["stop"]["transmit"] is True  # only the final child transmits


# ── Task 5: Trailing Stop, GTD, MOC, LOC ──────────────────────────────────────

def test_trailing_stop_percent_preview_has_one_leg_with_final_transmit():
    client = _client()
    req = {
        "kind": "trailing_stop",
        "conid": 270639,
        "symbol": "INTC",
        "side": "SELL",
        "quantity": 50,
        "order_type": "TRAIL",
        "trail": {"mode": "percent", "value": 5},
    }

    r = client.post("/execution-assistant/order-packages/preview", json=req)

    assert r.status_code == 200
    legs = r.json()["legs"]
    assert len(legs) == 1  # a standalone order, not a parent/child package
    leg = legs[0]
    assert leg["role"] == "trailing_stop"
    assert leg["order_type"] == "TRAIL"
    assert leg["trail"] == {"mode": "percent", "value": 5}
    assert leg["parent_ref"] is None
    assert leg["transmit"] is True


def test_loc_preview_rejects_missing_limit_price():
    client = _client()
    req = {
        "kind": "loc",
        "conid": 270639,
        "symbol": "INTC",
        "side": "SELL",
        "quantity": 50,
        "order_type": "MKT",
        "limit_price": None,
    }

    r = client.post("/execution-assistant/order-packages/preview", json=req)

    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "invalid_order_package"
    assert any("positive limit_price" in e for e in r.json()["detail"]["errors"])


def test_gtd_trail_rejects_stray_stop_price():
    """Regression test: a percent-trail GTD order carrying an unrelated stop_price
    must be rejected at the trust boundary. Without this check it would pass preview
    and reach the adapter, which sets order.auxPrice from stop_price and
    order.trailingPercent from trail unconditionally whenever each is non-null —
    producing a broker order with both set, violating their required mutual
    exclusivity."""
    client = _client()
    req = {
        "kind": "gtd",
        "conid": 270639,
        "symbol": "INTC",
        "side": "SELL",
        "quantity": 50,
        "order_type": "TRAIL",
        "trail": {"mode": "percent", "value": 5},
        "stop_price": 12.34,
        "good_till_date": "20260801 16:00:00",
    }

    r = client.post("/execution-assistant/order-packages/preview", json=req)

    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "invalid_order_package"
    assert any("must not have a stop_price" in e for e in r.json()["detail"]["errors"])


# ── Task 6: One Price-Condition Slice ────────────────────────────────────────

def _price_condition_request(**overrides) -> dict:
    base = {
        "kind": "price_condition",
        "conid": 270639,
        "symbol": "INTC",
        "side": "BUY",
        "quantity": 20,
        "order_type": "MKT",
        "condition_price": 120,
        "condition_is_above": True,
    }
    base.update(overrides)
    return base


def test_price_condition_preview_has_one_leg_with_condition_fields_and_transmit():
    client = _client()
    req = _price_condition_request()

    r = client.post("/execution-assistant/order-packages/preview", json=req)

    assert r.status_code == 200
    legs = r.json()["legs"]
    assert len(legs) == 1  # a plain order with one trigger attached, not a package of legs
    leg = legs[0]
    assert leg["role"] == "price_condition"
    assert leg["condition_price"] == 120
    assert leg["condition_is_above"] is True
    assert leg["parent_ref"] is None
    assert leg["transmit"] is True


def test_place_order_package_attaches_one_price_condition_to_the_broker_order():
    """Adapter-level regression test: the placed ib_async Order must carry exactly
    one PriceCondition with the request's conid, SMART exchange, isMore, and price —
    not a broad condition builder, just this one minimal attachment."""
    req = TwsOrderPackageRequest(**_price_condition_request(side="SELL", condition_is_above=False, condition_price=115))
    preview = preview_order_package(req)

    adapter = TwsBrokerAdapter()
    adapter._state = "connected"
    adapter._connected_port = 4002  # paper port

    placed = []

    class _FakeTrade:
        def __init__(self, order):
            self.order = order
            self.orderStatus = SimpleNamespace(status="PreSubmitted")

    class _FakeEvent:
        def __iadd__(self, fn):
            return self

        def __isub__(self, fn):
            return self

    fake_ib = MagicMock()
    fake_ib.isConnected.return_value = True
    fake_ib.client.getReqId.side_effect = iter(range(1, 100))
    fake_ib.errorEvent = _FakeEvent()
    fake_ib.placeOrder.side_effect = lambda contract, order: placed.append(order) or _FakeTrade(order)
    adapter._ib = fake_ib

    asyncio.run(adapter.place_order_package(preview, mode="paper"))

    assert len(placed) == 1
    order = placed[0]
    assert len(order.conditions) == 1
    condition = order.conditions[0]
    assert condition.conId == req.conid
    assert condition.exch == "SMART"
    assert condition.isMore is False
    assert condition.price == 115


# ── Modify guard: OCA-linked legs can't be revised in place ───────────────────

def test_modify_order_refuses_oca_grouped_order_before_calling_placeorder():
    """Regression: IBKR rejects revising an order with an explicit ocaGroup
    (error 10326 "OCA group revision is not allowed"), and the rejected
    resubmission cancels the order instead of leaving it untouched — observed
    live against a scale-out stop leg. The guard must fire before placeOrder()
    is ever called, for every caller, not just the UI path that hit it."""
    adapter = TwsBrokerAdapter()
    adapter._state = "connected"
    adapter._connected_port = 4002  # paper port

    order = SimpleNamespace(orderId=417, orderType="STP", ocaGroup="ORBIT-pkg-LOT0", parentId=415)
    trade = SimpleNamespace(order=order, contract=SimpleNamespace())

    fake_ib = MagicMock()
    fake_ib.isConnected.return_value = True
    fake_ib.openTrades.return_value = [trade]
    adapter._ib = fake_ib

    req = TwsModifyOrderRequest(quantity=12, limit_price=None, stop_price=116.0)
    raised = None
    try:
        asyncio.run(adapter.modify_order(417, req, mode="paper"))
    except TwsPlaceOrderGuardError as exc:
        raised = exc

    assert raised is not None
    assert raised.error_code == "oca_group_modify_unsupported"
    fake_ib.placeOrder.assert_not_called()
