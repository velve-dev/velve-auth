/* An account can turn every way back in that does not use one of its own credentials off
   (section 3.18, S-INTEG-11). recovery_disabled_at is set while the switch is on and null
   otherwise, and the seal covers whether it is set (S-INTEG-2), so a write to this column
   without the root key is a broken state and never turns the switch off. Adding a nullable
   column rewrites no row, and an account that never turns the switch on keeps the seal it had,
   so nobody is signed out and no pending state ends. */
ALTER TABLE velve.user
  ADD COLUMN recovery_disabled_at timestamptz;
