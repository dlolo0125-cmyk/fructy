-- One active daily quiz per calendar date.
CREATE UNIQUE INDEX daily_questions_one_active_per_day_idx
  ON daily_questions(question_date)
  WHERE active=true;
