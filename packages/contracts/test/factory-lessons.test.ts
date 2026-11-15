import { describe, expect, it } from "vitest";
import {
  cleanLessons,
  DigestLesson,
  EventEnvelope,
  FactoryDigest,
  FactoryItem,
  FactoryLesson,
  FactoryLessonResponse,
  FactoryStatus,
  FactoryTuning,
  FactoryTuningPatch,
  LESSON_BRIEF_DELAY_MS,
  LESSON_MAX,
  LESSONS_PER_VERDICT,
  lessonInBriefsAt,
  lessonKey,
  ReviewVerdict,
  ReviewVerdictSubmission,
} from "../src";
import { ts } from "./fixtures";

/** The factory's lessons (§10.1, #326): what reviewers record and later briefs carry. */

const lesson: FactoryLesson = {
  id: "l1",
  projectId: "p1",
  text: "Every user-facing change adds a changelog fragment in changes/.",
  key: lessonKey("Every user-facing change adds a changelog fragment in changes/."),
  itemId: "i1",
  prNumber: 12,
  reviewerProvider: "codex",
  times: 2,
  createdAt: ts,
  lastSeenAt: ts,
  removedAt: null,
};

const verdict = {
  verdict: "approve",
  summary: "ok",
  vision: { aligned: true },
  tests: { adequate: true },
  security: {},
};

describe("factory lessons", () => {
  it("round-trip a lesson, its event and the forget response", () => {
    expect(FactoryLesson.parse(JSON.parse(JSON.stringify(lesson)))).toEqual(lesson);
    const forgotten = { ...lesson, removedAt: ts };
    expect(FactoryLessonResponse.parse({ lesson: forgotten }).lesson).toEqual(forgotten);
    const env = EventEnvelope.parse({
      seq: 1,
      type: "factory.lesson.updated",
      sessionId: null,
      ts,
      payload: { lesson },
    });
    expect(env.type === "factory.lesson.updated" && env.payload.lesson).toEqual(lesson);
    expect(FactoryLesson.safeParse({ ...lesson, text: "" }).success).toBe(false);
    expect(FactoryLesson.safeParse({ ...lesson, text: "x".repeat(LESSON_MAX + 1) }).success).toBe(
      false,
    );
    expect(FactoryLesson.safeParse({ ...lesson, times: 0 }).success).toBe(false);
  });

  it("key a lesson the same way however it is cased, spaced or ended", () => {
    const key = lessonKey("Run the focused tests first.");
    expect(lessonKey("  run the   FOCUSED tests first ")).toBe(key);
    expect(lessonKey("Run the focused tests first!")).toBe(key);
    expect(lessonKey("Run the focused tests first...")).toBe(key);
    expect(lessonKey("Run the focused tests later")).not.toBe(key);
    expect(lessonKey(" . ")).toBe("");
  });

  it("clean submitted lessons: trimmed, masked, cut, deduped, at most three", () => {
    expect(
      cleanLessons([
        "  Add a changelog\n fragment.  ",
        "",
        "   ",
        "add a changelog fragment",
        "x".repeat(LESSON_MAX + 100),
        "Pass token=abc123secretvalue to the CLI",
        "A fourth lesson",
      ]),
    ).toEqual([
      "Add a changelog fragment.",
      `${"x".repeat(LESSON_MAX - 1)}…`,
      "Pass token=*** to the CLI",
    ]);
    expect(cleanLessons([])).toEqual([]);
    for (const text of cleanLessons(["y".repeat(5_000)])) {
      expect(text.length).toBeLessThanOrEqual(LESSON_MAX);
    }
  });

  it("verdicts carry at most three lessons; ones stored before lessons existed parse", () => {
    const old = ReviewVerdict.parse(verdict);
    expect(old.lessons).toEqual([]);
    const withLessons = ReviewVerdict.parse({
      ...verdict,
      lessons: ["Run pnpm lint before pushing"],
    });
    expect(ReviewVerdict.parse(JSON.parse(JSON.stringify(withLessons)))).toEqual(withLessons);
    const four = ["a", "b", "c", "d"];
    expect(four.length).toBeGreaterThan(LESSONS_PER_VERDICT);
    expect(ReviewVerdict.safeParse({ ...verdict, lessons: four }).success).toBe(false);
    expect(
      ReviewVerdict.safeParse({ ...verdict, lessons: ["z".repeat(LESSON_MAX + 1)] }).success,
    ).toBe(false);
    // The tool's input takes any lessons; it cleans them before they are stored.
    const submitted = ReviewVerdictSubmission.parse({
      ...verdict,
      lessons: [...four, "z".repeat(LESSON_MAX + 1), ""],
    });
    expect(submitted.lessons).toHaveLength(6);
    expect(
      ReviewVerdict.safeParse({ ...submitted, lessons: cleanLessons(submitted.lessons) }).success,
    ).toBe(true);
  });

  it("learn from reviews by default; the switch saves as a patch; status lists none by default", () => {
    expect(FactoryTuning.parse({}).learnFromReviews).toBe(true);
    expect(FactoryTuningPatch.parse({ learnFromReviews: false })).toEqual({
      learnFromReviews: false,
    });
    expect(FactoryTuningPatch.parse({})).toEqual({});
    expect(FactoryStatus.shape.lessons.parse(undefined)).toEqual([]);
  });

  it("go into briefs a day after they are learned; digests list them, older ones none (#391)", () => {
    expect(lessonInBriefsAt(lesson).getTime() - Date.parse(ts)).toBe(LESSON_BRIEF_DELAY_MS);
    expect(LESSON_BRIEF_DELAY_MS).toBe(24 * 60 * 60 * 1000);
    const learned: DigestLesson = {
      lessonId: "l1",
      text: lesson.text,
      issueNumber: 3,
      prNumber: 12,
    };
    expect(DigestLesson.parse(JSON.parse(JSON.stringify(learned)))).toEqual(learned);
    expect(DigestLesson.safeParse({ ...learned, issueNumber: 0 }).success).toBe(false);
    expect(FactoryDigest.shape.lessons.parse(undefined)).toEqual([]);
    expect(FactoryItem.shape.lessonsNote.parse(undefined)).toBeNull();
  });
});
