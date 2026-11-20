/* The proof of work hands out its challenges without storing them and keeps a challenge only
   once it has been spent, until the challenge expires (section 3.9, S-RATE-10). A spent challenge
   is kept by the SHA-256 of the challenge as it was handed out, so a second spend of the same
   challenge meets the primary key and is refused, and maintenance.sweep deletes the row once
   expires_at has passed by the database clock, the clock the spending statement checks the expiry
   by. The table belongs to no account and the migration rewrites no row. */
CREATE TABLE velve.proof_of_work_spent (
  challenge_sha256 bytea PRIMARY KEY CHECK (octet_length(challenge_sha256) = 32),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX proof_of_work_spent_sweep_idx ON velve.proof_of_work_spent (expires_at);
