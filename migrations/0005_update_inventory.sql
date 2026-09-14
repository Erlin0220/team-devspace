/* Optional low-frequency snapshot. Older Workers and clients remain compatible. */
ALTER TABLE access_keys ADD COLUMN update_report TEXT;
