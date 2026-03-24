-- Migration: province/state + subcontractor payee_name
-- Run in Supabase SQL Editor

-- ============================================================
-- 1. Province/state columns
-- ============================================================
ALTER TABLE chiefos_pending_signups ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE chiefos_tenants         ADD COLUMN IF NOT EXISTS province text;

-- ============================================================
-- 2. Subcontractor payee_name on canonical tables
-- ============================================================
ALTER TABLE transactions         ADD COLUMN IF NOT EXISTS payee_name text;
ALTER TABLE intake_item_drafts   ADD COLUMN IF NOT EXISTS payee_name text;
