ALTER TABLE velve.user
  ADD CONSTRAINT user_identity_mode CHECK (username IS NOT NULL);
