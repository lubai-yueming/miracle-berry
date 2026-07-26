const form = document.getElementById('player-form');
const input = document.getElementById('player-count');
const resultEl = document.getElementById('result');
let games = [];
let currentMatches = [];

async function loadGames() {
    try {
        const response = await fetch('games.json');
        games = await response.json();
    } catch (err) {
        showMessage('Could not load games.json. If you opened this file directly (file://), please serve it via a local server or view it through GitHub Pages instead.', 'error');
    }
}

function showMessage(text, className) {
    resultEl.className = className;
    resultEl.innerHTML = text;
}

function showRandomPick() {
    const pick = currentMatches[Math.floor(Math.random() * currentMatches.length)];
    const rerollBtn = currentMatches.length > 1
        ? '<button id="reroll-btn" type="button">🎲 Pick Another</button>'
        : '';
    showMessage(
        `<div id="picked-game">🎉 You should play: <strong>${pick.name}</strong></div>${rerollBtn}`,
        'success'
    );
    const btn = document.getElementById('reroll-btn');
    if (btn) {
        btn.addEventListener('click', showRandomPick);
    }
}

function handleSubmit(event) {
    event.preventDefault();

    const numPlayers = parseInt(input.value, 10);
    if (isNaN(numPlayers) || numPlayers < 1) {
        showMessage('Please enter a valid number of players.', 'error');
        return;
    }

    currentMatches = games.filter(
        (game) => numPlayers >= game.min_players && numPlayers <= game.max_players
    );

    if (currentMatches.length > 0) {
        showRandomPick();
    } else {
        const overallMin = Math.min(...games.map((game) => game.min_players));
        const overallMax = Math.max(...games.map((game) => game.max_players));
        showMessage(
            `No game supports ${numPlayers} player(s). Min player is ${overallMin} and max player is ${overallMax}. Please enter again.`,
            'error'
        );
    }
}

form.addEventListener('submit', handleSubmit);
loadGames();
