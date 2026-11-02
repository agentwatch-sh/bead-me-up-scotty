"use client";
import * as React from "react";
import type { HumanBody } from "@/lib/human-validate";

/** Posts an answer somewhere else (To Review sends a Reverse); a throw keeps what the person typed. */
export type AnswerSubmit = (body: HumanBody) => Promise<unknown>;

/** Runs an override submit with its own pending flag and error text. */
export function useAnswerSubmit(submit: AnswerSubmit | undefined) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = async (body: HumanBody) => {
    setPending(true);
    setError(null);
    try {
      await submit?.(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The answer could not be saved.");
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}
