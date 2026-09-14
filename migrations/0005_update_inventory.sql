/* Optional low-frequency snapshot; older Workers and clients remain compatible. */
ALTER TABLE access_keys ADD COLUMN update_report TEXT;
