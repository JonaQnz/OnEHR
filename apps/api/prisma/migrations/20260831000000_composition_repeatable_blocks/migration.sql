-- Runtime-repeatable Composition blocks (manualAdd): a block can now hold
-- zero, one, or several child FormSessions instead of exactly one.
-- childSessions keeps the existing 1:1 mapping for ordinary blocks;
-- childSessionGroups holds the ordered instance list for manualAdd blocks.
ALTER TABLE "composition_sessions" ADD COLUMN "child_session_groups" JSONB NOT NULL DEFAULT '{}';
