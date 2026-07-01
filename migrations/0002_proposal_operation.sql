ALTER TABLE update_proposals
ADD COLUMN operation TEXT NOT NULL DEFAULT 'update'
CHECK (operation IN ('create', 'update', 'delete'));
