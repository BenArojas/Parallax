import type { OrderSnapshot, ReconciliationSnapshot, TwsPackageWarning } from "./api";

export interface ParsedScaleOutRole {
  packageId: string;
  lotIndex: number;
  roleType: "entry" | "target" | "stop" | "trail" | "moc_fallback";
}

export interface ScaleOutOrderPackage {
  packageId: string;
  conid: number;
  symbol: string;
  orders: OrderSnapshot[];
  warnings: TwsPackageWarning[];
  lots: Array<{
    lotIndex: number;
    entry: OrderSnapshot | null;
    exits: OrderSnapshot[];
  }>;
}

const SCALE_OUT_REF = /^ORBIT:TWS:([^:]+):lot(\d+)_(entry|target|stop|trail|moc_fallback)$/;

const EXIT_ROLE_ORDER: Record<string, number> = { target: 0, stop: 1, trail: 2, moc_fallback: 3 };

export function parseScaleOutOrderRef(orderRef: string | null): ParsedScaleOutRole | null {
  if (!orderRef) return null;
  const match = SCALE_OUT_REF.exec(orderRef);
  if (!match) return null;
  return {
    packageId: match[1],
    lotIndex: Number(match[2]),
    roleType: match[3] as ParsedScaleOutRole["roleType"],
  };
}

export function groupScaleOutOrders(recon: ReconciliationSnapshot): {
  packages: ScaleOutOrderPackage[];
  standaloneOrders: OrderSnapshot[];
} {
  const packagesById = new Map<string, ScaleOutOrderPackage>();
  const standaloneOrders: OrderSnapshot[] = [];

  for (const order of recon.open_orders) {
    const parsed = parseScaleOutOrderRef(order.order_ref);
    if (!parsed) {
      standaloneOrders.push(order);
      continue;
    }

    let pkg = packagesById.get(parsed.packageId);
    if (!pkg) {
      pkg = {
        packageId: parsed.packageId,
        conid: order.conid,
        symbol: order.symbol,
        orders: [],
        warnings: recon.package_warnings.filter((w) => w.package_id === parsed.packageId),
        lots: [],
      };
      packagesById.set(parsed.packageId, pkg);
    }
    pkg.orders.push(order);

    let lot = pkg.lots.find((l) => l.lotIndex === parsed.lotIndex);
    if (!lot) {
      lot = { lotIndex: parsed.lotIndex, entry: null, exits: [] };
      pkg.lots.push(lot);
    }
    if (parsed.roleType === "entry") {
      lot.entry = order;
    } else {
      lot.exits.push(order);
    }
  }

  const packages = Array.from(packagesById.values());
  for (const pkg of packages) {
    pkg.lots.sort((a, b) => a.lotIndex - b.lotIndex);
    for (const lot of pkg.lots) {
      lot.exits.sort((a, b) => {
        const roleA = parseScaleOutOrderRef(a.order_ref)?.roleType ?? "target";
        const roleB = parseScaleOutOrderRef(b.order_ref)?.roleType ?? "target";
        return EXIT_ROLE_ORDER[roleA] - EXIT_ROLE_ORDER[roleB];
      });
    }
  }

  return { packages, standaloneOrders };
}
