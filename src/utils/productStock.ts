// Per-variant stock for store products.
//
// A product tracks its quantity at the most specific level it has:
//   - colors with sizes  -> color.size_stock { [size]: qty }
//   - colors, no sizes   -> color.stock
//   - sizes, no colors   -> product size_stock column { [size]: qty }
//   - neither            -> product stock column
// The product stock column always holds the total, so listings and "out of stock" badges keep working.
//
// Products saved before per-variant stock existed carry no variant quantities; they stay on the
// single total until an admin saves them again from the dashboard.

const toQty = (value: unknown): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  if (!value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const parseArray = (value: unknown): any[] => {
  const parsed = parseJson<any>(value, []);
  return Array.isArray(parsed) ? parsed : [];
};

const parseObject = (value: unknown): Record<string, unknown> => {
  const parsed = parseJson<any>(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
};

const sizeName = (size: unknown): string =>
  typeof size === 'object' && size !== null ? String((size as any).name ?? '') : String(size ?? '');

const colorName = (color: unknown): string =>
  typeof color === 'object' && color !== null ? String((color as any).name ?? '') : String(color ?? '');

// Keeps only the listed sizes, each with a whole non-negative quantity
const cleanSizeStock = (sizes: string[], raw: unknown): Record<string, number> => {
  const source = parseObject(raw);
  const result: Record<string, number> = {};
  for (const size of sizes) result[size] = toQty(source[size]);
  return result;
};

const sumValues = (obj: Record<string, number>): number => Object.values(obj).reduce((a, b) => a + b, 0);

export interface NormalizedStock {
  sizes: string[];
  colors: any[];
  size_stock: Record<string, number>;
  stock: number;
}

// Shapes what the dashboard sends into stored form and computes the total from the variants
export const normalizeProductStock = (input: {
  sizes: unknown;
  colors: unknown;
  size_stock: unknown;
  stock: unknown;
}): NormalizedStock => {
  const sizes = parseArray(input.sizes).map(sizeName).filter(Boolean);
  const rawColors = parseArray(input.colors);

  if (rawColors.length > 0) {
    let total = 0;
    const colors = rawColors.map((c) => {
      if (typeof c !== 'object' || c === null) return c;
      const colorSizes = parseArray(c.sizes).map(sizeName).filter(Boolean);
      if (colorSizes.length > 0) {
        const sizeStock = cleanSizeStock(colorSizes, c.size_stock);
        const colorTotal = sumValues(sizeStock);
        total += colorTotal;
        return { ...c, sizes: colorSizes, size_stock: sizeStock, stock: colorTotal };
      }
      const colorStock = toQty(c.stock);
      total += colorStock;
      const { size_stock: _drop, ...rest } = c;
      return { ...rest, sizes: [], stock: colorStock };
    });
    return { sizes, colors, size_stock: {}, stock: total };
  }

  if (sizes.length > 0) {
    const sizeStock = cleanSizeStock(sizes, input.size_stock);
    return { sizes, colors: [], size_stock: sizeStock, stock: sumValues(sizeStock) };
  }

  return { sizes, colors: [], size_stock: {}, stock: toQty(input.stock) };
};

// True once the product has been saved with per-variant quantities
export const hasVariantStock = (product: any): boolean => {
  if (Object.keys(parseObject(product.size_stock)).length > 0) return true;
  return parseArray(product.colors).some(
    (c) => typeof c === 'object' && c !== null && ('stock' in c || 'size_stock' in c)
  );
};

export interface StockChange {
  colors: any[];
  size_stock: Record<string, number>;
  stock: number;
}

export type StockAdjustResult =
  | { ok: true; change: StockChange }
  | { ok: false; reason: 'unknown_variant' | 'insufficient'; available: number };

// Applies delta (negative to take, positive to give back) to the variant the customer picked.
// Never lets a quantity go below zero.
export const adjustVariantStock = (
  product: any,
  color: unknown,
  size: unknown,
  delta: number
): StockAdjustResult => {
  const colors = parseArray(product.colors);
  const sizeStock = parseObject(product.size_stock) as Record<string, number>;
  const pickedColor = colorName(color).trim();
  const pickedSize = sizeName(size).trim();

  if (!hasVariantStock(product)) {
    const current = toQty(product.stock);
    if (current + delta < 0) return { ok: false, reason: 'insufficient', available: current };
    return { ok: true, change: { colors, size_stock: sizeStock, stock: current + delta } };
  }

  const apply = (current: number): number | null => (current + delta < 0 ? null : current + delta);

  if (colors.length > 0) {
    const idx = colors.findIndex((c) => colorName(c) === pickedColor);
    if (idx === -1 || typeof colors[idx] !== 'object') return { ok: false, reason: 'unknown_variant', available: 0 };
    const c = { ...colors[idx] };
    const colorSizes = parseArray(c.sizes).map(sizeName);

    if (colorSizes.length > 0) {
      if (!colorSizes.includes(pickedSize)) return { ok: false, reason: 'unknown_variant', available: 0 };
      const cs = { ...parseObject(c.size_stock) } as Record<string, number>;
      const current = toQty(cs[pickedSize]);
      const next = apply(current);
      if (next === null) return { ok: false, reason: 'insufficient', available: current };
      cs[pickedSize] = next;
      c.size_stock = cs;
      c.stock = sumValues(Object.fromEntries(Object.entries(cs).map(([k, v]) => [k, toQty(v)])));
    } else {
      const current = toQty(c.stock);
      const next = apply(current);
      if (next === null) return { ok: false, reason: 'insufficient', available: current };
      c.stock = next;
    }

    const nextColors = [...colors];
    nextColors[idx] = c;
    const total = nextColors.reduce((sum, col) => sum + (typeof col === 'object' && col !== null ? toQty(col.stock) : 0), 0);
    return { ok: true, change: { colors: nextColors, size_stock: {}, stock: total } };
  }

  if (!(pickedSize in sizeStock)) return { ok: false, reason: 'unknown_variant', available: 0 };
  const current = toQty(sizeStock[pickedSize]);
  const next = apply(current);
  if (next === null) return { ok: false, reason: 'insufficient', available: current };
  const nextSizeStock: Record<string, number> = {};
  for (const [k, v] of Object.entries(sizeStock)) nextSizeStock[k] = toQty(v);
  nextSizeStock[pickedSize] = next;
  return { ok: true, change: { colors, size_stock: nextSizeStock, stock: sumValues(nextSizeStock) } };
};

// Locks the product row and applies the change inside the caller's transaction
export const applyVariantStockChange = async (
  client: any,
  productId: string,
  color: unknown,
  size: unknown,
  delta: number
): Promise<StockAdjustResult | null> => {
  const res = await client.query('SELECT * FROM store_products WHERE id = $1 FOR UPDATE', [productId]);
  if (res.rows.length === 0) return null;
  const result = adjustVariantStock(res.rows[0], color, size, delta);
  if (result.ok) {
    await client.query(
      'UPDATE store_products SET colors = $1, size_stock = $2, stock = $3 WHERE id = $4',
      [JSON.stringify(result.change.colors), JSON.stringify(result.change.size_stock), result.change.stock, productId]
    );
  }
  return result;
};

// Parsed JSON fields for API responses
export const parseProductRow = (p: any) => ({
  ...p,
  images: parseArray(p.images),
  sizes: parseArray(p.sizes),
  colors: parseArray(p.colors),
  size_stock: parseObject(p.size_stock),
});
