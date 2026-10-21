import { useEffect, useState } from 'react';
import { useCommitmentSearch } from '../../api/queries';
import type { Commitment } from '../../api/schemas/common';
import { useSearchHistoryOn } from '../m6/capabilities';
import { MIN_SERVER_QUERY, needleOf, rankCommitments, type Needle } from './searchModel';

const DEBOUNCE_MS = 300;

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface CommitmentMatches {
  needle: Needle;
  commitments: Commitment[];
  /** The server had more than it sent: the person should narrow the search (R4-006). */
  truncated: boolean;
}

/**
 * The commitments matching what is typed: what this screen has loaded,
 * immediately, plus — with the capability on — the server's search over done,
 * dropped and older items, after the typing settles (D54-1).
 */
export function useCommitmentMatches(raw: string, local: readonly Commitment[], shownAt: (item: Commitment) => string | null): CommitmentMatches {
  const needle = needleOf(raw);
  const settled = needleOf(useDebounced(raw, DEBOUNCE_MS));
  const on = useSearchHistoryOn() === true;
  const ask = on && settled.searchable && settled.folded.length >= MIN_SERVER_QUERY && settled.folded === needle.folded;
  const server = useCommitmentSearch(settled.folded, settled.raw, ask);
  const serverItems = ask && server.data ? server.data.items : [];
  return {
    needle,
    commitments: needle.searchable ? rankCommitments(local, serverItems, needle, shownAt) : [],
    truncated: ask && server.data?.truncated === true,
  };
}
