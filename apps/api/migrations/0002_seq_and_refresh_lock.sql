-- Faz 9: Queue at-least-once teslimine karşı adım sırası; eşzamanlı token yenilemesine karşı kilit.
ALTER TABLE posts ADD COLUMN msg_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN refresh_lock_until TEXT;
