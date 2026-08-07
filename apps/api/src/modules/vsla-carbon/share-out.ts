import { BadRequestException } from '@nestjs/common';

/**
 * Deterministic VSLA share-out math (wave VSLACARBON). At cycle close the
 * distributable pool (the group's pooled-cash ledger balance) is split
 * pro-rata over member contribution totals with the LARGEST-REMAINDER
 * method so conservation holds exactly:
 *
 *   sum(share_i) == distributableKobo        (no kobo created or lost)
 *   share_i     <= contributed_i + surplus share of interest earnings
 *   residual_i  == max(0, contributed_i - share_i)  (deferred while loans
 *                                                  are outstanding)
 *
 * Determinism: ties in the remainder ranking break by memberId ascending,
 * so the same inputs always produce the same payout vector regardless of
 * map/row ordering.
 */

export interface ShareOutMemberInput {
  memberId: string;
  contributedKobo: number;
}

export interface ShareOutPayout {
  memberId: string;
  /** Amount actually paid out at close. */
  shareKobo: number;
  contributedKobo: number;
  /** Contribution liability left on the member account after payout. */
  residualKobo: number;
}

export function computeShareOut(
  members: readonly ShareOutMemberInput[],
  distributableKobo: number
): ShareOutPayout[] {
  if (!Number.isSafeInteger(distributableKobo) || distributableKobo < 0) {
    throw new BadRequestException('distributableKobo must be a non-negative integer');
  }
  for (const member of members) {
    if (!Number.isSafeInteger(member.contributedKobo) || member.contributedKobo < 0) {
      throw new BadRequestException('contributedKobo must be a non-negative integer');
    }
  }
  const totalContributed = members.reduce((sum, member) => sum + member.contributedKobo, 0);
  if (members.length === 0 || totalContributed === 0 || distributableKobo === 0) {
    return members.map((member) => ({
      memberId: member.memberId,
      shareKobo: 0,
      contributedKobo: member.contributedKobo,
      residualKobo: member.contributedKobo
    }));
  }

  // Exact pro-rata floor + largest-remainder top-up to conserve the total.
  const ranked = members
    .map((member) => {
      const exact = (member.contributedKobo * distributableKobo) / totalContributed;
      const floor = Math.floor(exact);
      return {
        memberId: member.memberId,
        contributedKobo: member.contributedKobo,
        floor,
        remainder: exact - floor
      };
    })
    .sort(
      (a, b) => b.remainder - a.remainder || (a.memberId < b.memberId ? -1 : 1)
    );

  const distributed = ranked.reduce((sum, entry) => sum + entry.floor, 0);
  let leftover = distributableKobo - distributed;
  for (const entry of ranked) {
    if (leftover <= 0) break;
    entry.floor += 1;
    leftover -= 1;
  }

  return members.map((member) => {
    const entry = ranked.find((candidate) => candidate.memberId === member.memberId);
    const shareKobo = entry?.floor ?? 0;
    return {
      memberId: member.memberId,
      shareKobo,
      contributedKobo: member.contributedKobo,
      residualKobo: Math.max(0, member.contributedKobo - shareKobo)
    };
  });
}
