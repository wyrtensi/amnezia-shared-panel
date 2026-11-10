import { randomInt } from "node:crypto";
import { z } from "zod";

/**
 * A per-key AmneziaWG 3.1 client profile: the parameters that only the client
 * sends, so each device can pick its own without touching the server.
 *
 * `Jc/Jmin/Jmax` shape the junk packets sent before the handshake, and the
 * order of `I1-I3` decides which signature packet goes first. The server
 * ignores both, so any value in range still connects to the same peer.
 *
 * The ranges follow the AWG 3.1 geometry this repository already uses.
 */
export const AWG_PROFILE_JC = { min: 3, max: 10 } as const;
export const AWG_PROFILE_JMIN = { min: 40, max: 100 } as const;
export const AWG_PROFILE_GAP = { min: 30, max: 200 } as const;
/** Index into the six orders of three entries; fewer entries use it modulo. */
export const AWG_PROFILE_ORDERS = 6;

export const awgClientProfileV1Schema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().min(1),
    jc: z.number().int().min(AWG_PROFILE_JC.min).max(AWG_PROFILE_JC.max),
    jmin: z.number().int().min(AWG_PROFILE_JMIN.min).max(AWG_PROFILE_JMIN.max),
    jmax: z.number().int(),
    cpsOrder: z
      .number()
      .int()
      .min(0)
      .max(AWG_PROFILE_ORDERS - 1),
  })
  .strict()
  .refine(
    (profile) =>
      profile.jmax - profile.jmin >= AWG_PROFILE_GAP.min &&
      profile.jmax - profile.jmin <= AWG_PROFILE_GAP.max,
    { message: "Jmax - Jmin is out of range", path: ["jmax"] },
  );

export type AwgClientProfileV1 = z.infer<typeof awgClientProfileV1Schema>;

/** An inclusive draw. */
const draw = (range: { min: number; max: number }): number =>
  randomInt(range.min, range.max + 1);

/**
 * Draw a fresh profile. `previousJc`, when it is in range, is excluded, so a
 * refresh always changes at least the junk packet count: the draw is uniform
 * over the remaining seven values.
 */
export const selectAwgClientProfile = (
  revision: number,
  previousJc?: number,
): AwgClientProfileV1 => {
  const excluded =
    previousJc !== undefined &&
    Number.isInteger(previousJc) &&
    previousJc >= AWG_PROFILE_JC.min &&
    previousJc <= AWG_PROFILE_JC.max;
  let jc = excluded
    ? draw({ min: AWG_PROFILE_JC.min, max: AWG_PROFILE_JC.max - 1 })
    : draw(AWG_PROFILE_JC);
  if (excluded && jc >= previousJc) jc += 1;
  const jmin = draw(AWG_PROFILE_JMIN);
  const jmax = jmin + draw(AWG_PROFILE_GAP);
  return awgClientProfileV1Schema.parse({
    version: 1,
    revision,
    jc,
    jmin,
    jmax,
    cpsOrder: randomInt(0, AWG_PROFILE_ORDERS),
  });
};

/** Every order of `count` entries, identity first. */
const ORDERS: Record<number, number[][]> = {
  2: [
    [0, 1],
    [1, 0],
  ],
  3: [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ],
};

/**
 * The order a saved index gives `count` populated entries. Six is a multiple
 * of both two and six, so the modulo keeps the pick uniform. One entry, or
 * none, stays as it is.
 */
export const profileOrder = (cpsOrder: number, count: number): number[] => {
  const identity = Array.from({ length: count }, (_, i) => i);
  const orders = ORDERS[count];
  return orders?.[cpsOrder % orders.length] ?? identity;
};
