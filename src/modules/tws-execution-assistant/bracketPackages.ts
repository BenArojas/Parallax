import type { OrderSnapshot, TwsPackageWarning } from "./api";

export interface ParsedBracketRole {
  packageId: string;
  roleType: "parent" | "target" | "stop" | "trail";
}

export interface BracketOrderPackage {
  packageId: string;
  conid: number;
  symbol: string;
  orders: OrderSnapshot[];
  warnings: TwsPackageWarning[];
  parent: OrderSnapshot | null;
  target: OrderSnapshot | null;
  exit: OrderSnapshot | null;
}

const BRACKET_REF = /^ORBIT:TWS:([^:]+):(parent|target|stop|trail)$/;

export function parseBracketOrderRef(orderRef: string | null): ParsedBracketRole | null {
  if (!orderRef) return null;
  const match = BRACKET_REF.exec(orderRef);
  if (!match) return null;
  return { packageId: match[1], roleType: match[2] as ParsedBracketRole["roleType"] };
}

/** Groups already-non-scale-out orders into bracket packages. Takes plain
 * orders + warnings (not a full ReconciliationSnapshot) so the caller can
 * chain this after groupScaleOutOrders without either grouping misclassifying
 * the other's orders as standalone. */
export function groupBracketOrders(
  orders: OrderSnapshot[],
  warnings: TwsPackageWarning[],
): { packages: BracketOrderPackage[]; standaloneOrders: OrderSnapshot[] } {
  const packagesById = new Map<string, BracketOrderPackage>();
  const standaloneOrders: OrderSnapshot[] = [];

  for (const order of orders) {
    const parsed = parseBracketOrderRef(order.order_ref);
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
        warnings: warnings.filter((w) => w.package_id === parsed.packageId),
        parent: null,
        target: null,
        exit: null,
      };
      packagesById.set(parsed.packageId, pkg);
    }
    pkg.orders.push(order);
    if (parsed.roleType === "parent") pkg.parent = order;
    else if (parsed.roleType === "target") pkg.target = order;
    else pkg.exit = order; // "stop" or "trail"
  }

  return { packages: Array.from(packagesById.values()), standaloneOrders };
}
