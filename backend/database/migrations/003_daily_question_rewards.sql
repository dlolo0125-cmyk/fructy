-- Add the configurable XOF reward for a correct daily answer.
ALTER TABLE daily_questions
  ADD COLUMN reward_amount bigint NOT NULL DEFAULT 0
  CHECK (reward_amount >= 0);
