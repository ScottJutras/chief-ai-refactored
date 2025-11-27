// handlers/commands/forecast.js
// Minimal stub so webhook.js can require this without crashing.
// You can wire real forecasting later (using /api/dashboard, etc.)

async function handleForecast(
  from,
  text,
  userProfile,
  ownerId,
  ownerProfile,
  isOwner,
  res
) {
  // For now, just say it's not implemented.
  if (res && !res.headersSent) {
    res
      .status(200)
      .type("application/xml")
      .send(
        `<Response><Message>Forecasting isn’t wired up yet, but I’m logging your request so we can add this.</Message></Response>`
      )
  }
  return true // or false if you want webhook to fall back to agent
}

module.exports = {
  handleForecast,
  forecastHandler: handleForecast, // export both names for safety
}
