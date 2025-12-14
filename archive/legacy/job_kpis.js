const { query } = require('../../services/postgres');
const { getJobKpis } = require('../../services/agentTools/getJobKpis');

function RESP(s){ return `<Response><Message>${s}</Message></Response>`; }

async function handleJobKpis(from, text, userProfile, ownerId, _ownerProfile, _isOwner, res) {
  const lc = String(text||'').toLowerCase();
  const m = lc.match(/^kpis?\s+for\s+(.+?)(?:\s+on\s+(\d{4}-\d{2}-\d{2}))?$/i);
  if (!m) return false;

  const name = m[1].trim();
  const day  = m[2] || new Date().toISOString().slice(0,10);
  const owner = String(ownerId).replace(/\D/g,'');

  // Resolve job_no by name
  const j = await query(
    `select job_no from public.jobs where owner_id=$1 and lower(coalesce(name,job_name))=lower($2) limit 1`,
    [owner, name]
  );
  const jobNo = j.rows?.[0]?.job_no;
  if (!jobNo) {
    res.status(200).type('application/xml').send(RESP(`No job found: ${name}`));
    return true;
  }

  const msg = await getJobKpis({ ownerId: owner, jobNo, day });
  res.status(200).type('application/xml').send(RESP(msg));
  return true;
}

module.exports = { handleJobKpis };
