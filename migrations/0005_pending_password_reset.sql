/* A mailed password reset of an account with a second factor holds its new password in the
   pending authentication until that factor is proven (section 3.6, S-FIX-7). new_password_phc
   is the PHC string sealed under password-enc and bound to the row's owner and token_sha256
   (S-INTEG-1), never the password itself, and the row's token_mac covers its SHA-256 and
   new_password_key_version (S-INTEG-9). Both columns are null on every other pending
   authentication, and a row with only one of them is refused by the database. Adding two
   nullable columns rewrites no row, so no pending authentication in flight ends, and a 2.x
   instance still running keeps inserting rows the new code reads as before. */
ALTER TABLE velve.pending_authentication
  ADD COLUMN new_password_phc bytea,
  ADD COLUMN new_password_key_version integer CHECK (new_password_key_version >= 1),
  ADD CONSTRAINT pending_authentication_new_password_whole
    CHECK ((new_password_phc IS NULL) = (new_password_key_version IS NULL));
