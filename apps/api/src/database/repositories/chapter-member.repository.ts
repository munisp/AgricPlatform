import type { ChapterMember } from '@agric-platform/shared';

/**
 * Write/read port over chapters.chapter_members (migration 001). Until the
 * membership wave the table had only the read-only roster SELECT in the
 * chapter-map aggregation; this repository is the writer path (GAP-M19).
 * Adds are idempotent upserts keyed by (chapterId, userId) so a retried
 * join never duplicates a membership row.
 */
export interface ChapterMemberRepository {
  /** All memberships of a chapter, oldest join first. */
  list(chapterId: string): Promise<ChapterMember[]>;
  find(chapterId: string, userId: string): Promise<ChapterMember | undefined>;
  /** Insert-or-update role keyed by (chapterId, userId); returns the stored row. */
  add(member: ChapterMember): Promise<ChapterMember>;
  /** Remove a membership. Returns true when a row was removed. */
  remove(chapterId: string, userId: string): Promise<boolean>;
}

export class InMemoryChapterMemberRepository implements ChapterMemberRepository {
  /** `${chapterId}|${userId}` -> member row. */
  private readonly items = new Map<string, ChapterMember>();

  constructor(seed: readonly ChapterMember[] = []) {
    for (const member of seed) {
      this.items.set(`${member.chapterId}|${member.userId}`, structuredClone(member));
    }
  }

  async list(chapterId: string): Promise<ChapterMember[]> {
    return [...this.items.values()]
      .filter((member) => member.chapterId === chapterId)
      .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt))
      .map((member) => structuredClone(member));
  }

  async find(chapterId: string, userId: string): Promise<ChapterMember | undefined> {
    const member = this.items.get(`${chapterId}|${userId}`);
    return member ? structuredClone(member) : undefined;
  }

  async add(member: ChapterMember): Promise<ChapterMember> {
    const key = `${member.chapterId}|${member.userId}`;
    const existing = this.items.get(key);
    // Idempotent re-join: keep the original joined_at, refresh the role.
    const stored: ChapterMember = existing
      ? { ...existing, role: member.role }
      : structuredClone(member);
    this.items.set(key, stored);
    return structuredClone(stored);
  }

  async remove(chapterId: string, userId: string): Promise<boolean> {
    return this.items.delete(`${chapterId}|${userId}`);
  }
}

export function createInMemoryChapterMemberRepository(
  seed: readonly ChapterMember[] = []
): InMemoryChapterMemberRepository {
  return new InMemoryChapterMemberRepository(seed);
}
