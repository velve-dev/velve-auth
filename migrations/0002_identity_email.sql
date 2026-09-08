ALTER TABLE velve.user
  ADD CONSTRAINT user_identity_mode CHECK (email IS NOT NULL);
