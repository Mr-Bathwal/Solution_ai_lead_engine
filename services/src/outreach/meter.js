/**
 * Spending meters on the `usage` collection (the same counters the Python side uses for vendor
 * calls). take() reserves an amount atomically before money is spent, and only while the period's
 * total stays within the cap, so two workers can never overrun a cap between them; settle() moves
 * the reservation to the real amount afterwards. Amounts are whole units (paise for rupees).
 */

/** 'YYYY-MM' of the IST month of an instant. */
export const istMonth = (at) => new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 7);

export class Meter {
  constructor(db, { clock = () => new Date() } = {}) {
    this.usage = db.collection('usage');
    this.clock = clock;
  }

  /** Reserves `amount` on meter/period if the total stays within `cap`. Returns true if reserved. */
  async take({ meter, period, amount, cap }) {
    if (!Number.isInteger(amount) || amount < 0) throw new TypeError('amount must be a whole number of at least 0');
    if (!Number.isInteger(cap) || cap < 0) throw new TypeError('cap must be a whole number of at least 0');
    const id = `${meter}:${period}`;
    const now = this.clock();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.usage.updateOne({ _id: id }, { $setOnInsert: { meter, period, count: 0, cap, updated_at: now } }, { upsert: true });
        break;
      } catch (err) {
        if (err?.code !== 11000 || attempt > 0) throw err;   // created by another worker at the same moment
      }
    }
    const r = await this.usage.findOneAndUpdate(
      { _id: id, count: { $lte: cap - amount } },
      { $inc: { count: amount }, $set: { cap, updated_at: now } },
      { returnDocument: 'after' },
    );
    return Boolean(r);
  }

  /** Replaces a reservation of `reserved` with the `actual` amount (never below zero in total). */
  async settle({ meter, period, reserved, actual }) {
    const delta = Math.round(actual) - reserved;
    if (!delta) return;
    await this.usage.updateOne({ _id: `${meter}:${period}` }, [{
      $set: { count: { $max: [0, { $add: ['$count', delta] }] }, updated_at: this.clock() },
    }]);
  }

  async used(meter, period) {
    return (await this.usage.findOne({ _id: `${meter}:${period}` }))?.count ?? 0;
  }
}
