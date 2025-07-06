function isValidExpenseInput(input) {
    const triggers = ['$', 'expense', 'revenue', 'earned'];
    return triggers.some(trigger => input.toLowerCase().includes(trigger));
}

function isOnboardingTrigger(input) {
    const triggers = ['start', 'hi', 'hello', 'hey', 'begin'];
    return triggers.includes(input.toLowerCase().trim());
}

function isValidCommand(input) {
    const commands = ['team', 'edit bill', 'delete bill', 'add', 'remove', 'stats', 'goal'];
    return commands.some(cmd => input.toLowerCase().startsWith(cmd));
}

module.exports = { isValidExpenseInput, isOnboardingTrigger, isValidCommand };