import { randomUUID } from "node:crypto";
import {
  type FactoryItem,
  type FactoryLesson,
  LESSONS_IN_BRIEF,
  lessonKey,
} from "@codeden/contracts";
import { notFound } from "../errors";
import type { FactoryContext } from "./context";
import type { BriefLessons } from "./prompts";

/**
 * The factory's lessons (§10.1): general rules its reviewers record with their verdicts, kept per
 * project and given to every later builder and reviewer in its brief, so a finding that comes back
 * item after item stops costing a revise round. "Learn from reviews" (`learnFromReviews`) switches
 * it off; a person can forget a lesson, which then is never learned again.
 */

/** Whether the project's factory learns from its reviews. */
export function learnsFromReviews(ctx: FactoryContext, projectId: string): boolean {
  return ctx.store.loopOrNew(projectId, ctx.now()).tuning.learnFromReviews;
}

/** What a new builder's or reviewer's brief gets: the newest lessons in force, if learning. */
export function briefLessons(ctx: FactoryContext, projectId: string): BriefLessons {
  if (!learnsFromReviews(ctx, projectId)) return { lessons: [], learn: false };
  const lessons = ctx.store.lessons(projectId, LESSONS_IN_BRIEF).map((l) => l.text);
  return { lessons, learn: true };
}

/**
 * Keep the lessons of a verdict on `item` (already cleaned, see `cleanLessons`). A lesson the
 * project has is recorded again (`times`, `lastSeenAt`); a forgotten one stays forgotten. Nothing
 * is kept from work let in from an untrusted author: a stranger's text steered that review, and a
 * lesson outlives its item and reaches every later brief. Returns the lessons recorded.
 */
export function recordLessons(
  ctx: FactoryContext,
  item: FactoryItem,
  lessons: readonly string[],
): FactoryLesson[] {
  if (lessons.length === 0 || item.trust !== "trusted") return [];
  if (!learnsFromReviews(ctx, item.projectId)) return [];
  const at = ctx.now().toISOString();
  const recorded: FactoryLesson[] = [];
  for (const text of lessons) {
    const key = lessonKey(text);
    if (!key) continue;
    const known = ctx.store.lessonByKey(item.projectId, key);
    if (known?.removedAt) continue;
    const lesson: FactoryLesson = known
      ? { ...known, times: known.times + 1, lastSeenAt: at }
      : {
          id: randomUUID(),
          projectId: item.projectId,
          text,
          key,
          itemId: item.id,
          prNumber: item.pr?.number ?? null,
          reviewerProvider: item.reviewerProvider,
          times: 1,
          createdAt: at,
          lastSeenAt: at,
          removedAt: null,
        };
    recorded.push(ctx.store.saveLesson(lesson));
  }
  return recorded;
}

/** Forget a lesson: it leaves the briefs and is never learned again. */
export function forgetLesson(
  ctx: FactoryContext,
  projectId: string,
  lessonId: string,
): FactoryLesson {
  const lesson = ctx.store.lesson(projectId, lessonId);
  if (!lesson) throw notFound("No such lesson", "lesson_not_found");
  if (lesson.removedAt) return lesson;
  return ctx.store.saveLesson({ ...lesson, removedAt: ctx.now().toISOString() });
}
