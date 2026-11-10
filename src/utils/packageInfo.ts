/*
 * Room pricing and the derived package fields every client reads. A room is offered only when the company
 * priced it: nothing here invents a price, so what the customer sees is exactly what they are charged.
 */

export const ROOM_KEYS = ['quad', 'triple', 'double', 'single'] as const;
export type RoomKey = (typeof ROOM_KEYS)[number];

export const ROOM_LABELS: Record<RoomKey, string> = {
  quad: 'غرفة رباعية',
  triple: 'غرفة ثلاثية',
  double: 'غرفة ثنائية',
  single: 'غرفة فردية',
};

export interface RoomOption {
  key: RoomKey;
  label: string;
  adult_price: number;
  child_price: number;
  children_allowed: boolean;
}

const parseJson = (value: any, fallback: any) => {
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const positive = (value: unknown): number => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

/**
 * Supports both stored shapes: the company form's flat map ({ quad: '1000', quad_child: '500',
 * quad_no_children: '1' }) and the admin form's nested one ({ quad: { adult, child } }).
 * An empty child price means children pay the adult price, unless the room refuses children.
 */
export const getRoomOptions = (pkg: { room_prices?: any; price?: any }): RoomOption[] => {
  const prices = parseJson(pkg.room_prices, {}) || {};
  const options: RoomOption[] = [];
  for (const key of ROOM_KEYS) {
    const entry = prices[key];
    let adult = 0;
    let child = 0;
    if (entry && typeof entry === 'object') {
      adult = positive(entry.adult ?? entry.price);
      child = positive(entry.child);
    } else {
      adult = positive(entry);
      child = positive(prices[`${key}_child`]);
    }
    if (adult <= 0) continue;
    const childrenAllowed = !(prices[`${key}_no_children`] === '1' || prices[`${key}_no_children`] === true || entry?.no_children === true);
    options.push({
      key,
      label: ROOM_LABELS[key],
      adult_price: adult,
      child_price: childrenAllowed ? child || adult : 0,
      children_allowed: childrenAllowed,
    });
  }
  // Older packages that only have one price are sold as quad rooms at that price
  if (options.length === 0 && positive(pkg.price) > 0) {
    options.push({ key: 'quad', label: ROOM_LABELS.quad, adult_price: positive(pkg.price), child_price: positive(pkg.price), children_allowed: true });
  }
  return options;
};

/**
 * The package's "starting from" price: the cheapest adult room the company priced. The customer app sorts and
 * filters by it. Accepts both stored room_prices shapes (flat or nested) and a JSON string.
 */
export const lowestAdultPrice = (roomPrices: any): number | null => {
  const prices = parseJson(roomPrices, {}) || {};
  const amounts = ROOM_KEYS.map((key) => {
    const entry = prices[key];
    return entry && typeof entry === 'object' ? positive(entry.adult ?? entry.price) : positive(entry);
  }).filter((value) => value > 0);
  return amounts.length > 0 ? Math.min(...amounts) : null;
};

export class BookingPriceError extends Error {}

export const calculateBookingTotal = (pkg: any, roomType: string, adults: number, children: number): number => {
  const option = getRoomOptions(pkg).find((room) => room.key === roomType);
  if (!option) throw new BookingPriceError('نوع الغرفة المختار غير متاح في هذه الباقة');
  if (children > 0 && !option.children_allowed) throw new BookingPriceError(`${option.label} لا تقبل أطفالاً في هذه الباقة`);
  return Math.round(adults * option.adult_price + children * option.child_price);
};

const asList = (value: any): string[] => {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
};

/**
 * Adds the fields the customer app shows, computed on the server: priced rooms, gallery, exclusions,
 * seats left, and the company's rating (packages have no reviews of their own).
 * Expects company_rating, company_reviews_count and seats_booked when the query selected them.
 */
export const enrichPackage = (fullRow: any) => {
  // Statistics belong to the company only, so they are kept out of what customers receive
  const { views_count: _views, shares_count: _shares, ...row } = fullRow;
  const gallery = asList(row.gallery);
  const seatsTotal = Number(row.seats_total) > 0 ? Number(row.seats_total) : null;
  const seatsBooked = Number(row.seats_booked || 0);
  return {
    ...row,
    room_options: getRoomOptions(row),
    gallery_images: [row.image_url, ...gallery].filter((url, index, list) => url && list.indexOf(url) === index),
    exclusions_list: asList(row.exclusions),
    seats_total: seatsTotal,
    seats_left: seatsTotal === null ? null : Math.max(0, seatsTotal - seatsBooked),
    includes_flight: Boolean(row.includes_flight),
    original_price: Number(row.original_price) > 0 ? Number(row.original_price) : null,
    rating: row.company_rating !== undefined && row.company_rating !== null ? Number(row.company_rating) : Number(row.rating || 0),
    reviews_count: row.company_reviews_count !== undefined ? Number(row.company_reviews_count || 0) : Number(row.reviews_count || 0),
  };
};

// SQL columns that enrichPackage reads; `p` is packages and `c` companies
export const PACKAGE_EXTRA_COLUMNS = `c.rating AS company_rating, c.reviews_count AS company_reviews_count,
  (SELECT COALESCE(SUM(b2.travelers_count), 0) FROM bookings b2 WHERE b2.package_id = p.id AND b2.status <> 'cancelled')::int AS seats_booked`;

export const SEASONS: Record<string, string> = {
  regular: 'عمرة عادية',
  ramadan: 'عمرة رمضان',
  shaban: 'عمرة شعبان',
  rajab: 'عمرة رجب',
  mid_year: 'عمرة نصف السنة',
  summer: 'عمرة الصيف',
  winter: 'عمرة الشتاء',
};
