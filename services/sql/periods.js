// services/sql/periods.js
const { startOfDay, startOfWeek, startOfMonth, startOfYear, subMonths } = require("date-fns");

function getPeriodBounds(period) {
  const now = new Date();

  switch ((period || "").toLowerCase()) {
    case "today": {
      const start = startOfDay(now);
      return { start, end: now };
    }

    case "this_week": {
      const start = startOfWeek(now, { weekStartsOn: 1 }); // Monday
      return { start, end: now };
    }

    case "this_month": {
      const start = startOfMonth(now);
      return { start, end: now };
    }

    case "last_month": {
      const start = startOfMonth(subMonths(now, 1));
      const end = startOfMonth(now);
      return { start, end };
    }

    case "ytd": {
      const start = startOfYear(now);
      return { start, end: now };
    }

    default: {
      // Default = this month
      const start = startOfMonth(now);
      return { start, end: now };
    }
  }
}

module.exports = {
  getPeriodBounds,
};
