// services/forecast.js
const map = new Map();
for (const p of series){
const dt = new Date(p.date);
const key = period==='week' ? `${dt.getUTCMonth()}-${Math.floor((dt.getUTCDate()-1)/7)}`
: `${dt.getUTCMonth()}`; // 0..11
const arr = map.get(key) || [];
arr.push(p); map.set(key, arr);
}
return map;



function mean(arr, key){
if (!arr.length) return 0;
return Math.round(arr.reduce((s,x)=>s+(x[key]||0),0)/arr.length);
}


function linearTrend(series, key){
// Simple OLS over t=0..n-1 to capture drift; returns slope per period
const n = series.length; if (n<2) return 0;
let sumT=0,sumY=0,sumTT=0,sumTY=0;
for (let i=0;i<n;i++){ const y=series[i][key]||0; sumT+=i; sumY+=y; sumTT+=i*i; sumTY+=i*y; }
const denom = n*sumTT - sumT*sumT; if (!denom) return 0;
return (n*sumTY - sumT*sumY)/denom; // slope
}


async function getForecast({ ownerId, jobId=null, period='week', horizon=4 }){
const s = await loadSeries({ ownerId, jobId, period });
if (s.length < 4) return { ok:false, error:'Not enough history (need ≥4 periods)' };


const season = groupBySeason(s, period);
const trendRev = linearTrend(s, 'revenue');
const trendProf= linearTrend(s, 'profit');
const trendLab = linearTrend(s, 'labor');


const out = []; const now = new Date();
for (let i=1;i<=horizon;i++){
const future = new Date(now);
if (period==='week') future.setDate(now.getDate()+i*7); else future.setMonth(now.getMonth()+i);
const key = period==='week' ? `${future.getUTCMonth()}-${Math.floor((future.getUTCDate()-1)/7)}`
: `${future.getUTCMonth()}`;
const hist = season.get(key)||[];


// Seasonal baseline (mean of same season across years)
const baseRev = mean(hist,'revenue');
const baseProf= mean(hist,'profit');
const baseLab = mean(hist,'labor');
const baseMin = mean(hist,'minutes');


// Add gentle trend (slope * 1 period)
const rev = Math.max(0, Math.round(baseRev + trendRev));
const prof= Math.max(0, Math.round(baseProf + trendProf));
const lab = Math.max(0, Math.round(baseLab + trendLab));


out.push({
date: future.toISOString().slice(0,10),
revenue_cents: rev,
gross_profit_cents: prof,
labour_cost_cents: lab,
paid_minutes: baseMin,
reason: hist.length
? `Based on ${hist.length} prior ${period}${hist.length>1?'s':''} for this season + linear trend`
: `No historical season match; using overall trend`
});
}


return { ok:true, period, horizon, forecast: out };
}


module.exports = { getForecast };