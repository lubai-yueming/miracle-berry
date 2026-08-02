const playerSection = document.getElementById('player-section');
const playerForm = document.getElementById('player-form');
const playerCountInput = document.getElementById('player-count');
const maxTimeInput = document.getElementById('max-time');
const playerStatusEl = document.getElementById('player-status');

const quizSection = document.getElementById('quiz-section');
const quizHeadingEl = document.getElementById('quiz-heading');
const quizForm = document.getElementById('quiz-form');
const quizQuestionsEl = document.getElementById('quiz-questions');
const quizStatusEl = document.getElementById('quiz-status');
const quizBackBtn = document.getElementById('quiz-back-btn');

const resultsSection = document.getElementById('results-section');
const resultsContentEl = document.getElementById('results-content');
const startOverBtn = document.getElementById('start-over-btn');

let games = [];
let quiz = [];
let numPlayers = 0;
let maxTime = 0;
let currentMatches = [];
let lastTopMatches = [];

async function loadGames() {
    try {
        const response = await fetch('games.json');
        games = await response.json();
    } catch (err) {
        setStatus(playerStatusEl, 'Could not load games.json. If you opened this file directly (file://), please serve it via a local server or view it through GitHub Pages instead.', 'error');
    }
}

async function loadQuiz() {
    try {
        const response = await fetch('quiz.json');
        quiz = await response.json();
    } catch (err) {
        console.error('Could not load quiz.json.', err);
    }
}

/**
 * Aggregates multi-player quiz answers into a per-game score.
 * For each question, `yesCount` players answered yes and the rest of the
 * group (totalPlayers - yesCount) are assumed to have answered no. Each
 * game's score is bumped by (yesCount * yesScore) + (noCount * noScore).
 * @param {Object.<string, number>} yesCounts - map of question id -> number of players who answered yes.
 * @param {number} totalPlayers - total number of players who answered the quiz.
 * @returns {Array<{id: string, name: string, score: number}>} every game, sorted by score descending.
 */
function scoreGames(yesCounts, totalPlayers) {
    const totals = {};
    games.forEach((game) => {
        totals[game.id] = 0;
    });

    quiz.forEach((question) => {
        const yesCount = yesCounts[question.id];
        if (typeof yesCount !== 'number' || Number.isNaN(yesCount)) {
            return;
        }
        const clampedYes = Math.min(Math.max(yesCount, 0), totalPlayers);
        const noCount = totalPlayers - clampedYes;
        Object.keys(question.scores).forEach((condition) => {
            const parts = condition.split(":");
            if (parts.length !== 2) {
                return;
            }
            const values = question.scores[condition];
            games.forEach((game) => {
                if ((parts[0] === "genres" && game.genres.includes(parts[1])) || (parts[0] === "complexity" && game.complexity === parts[1])) {
                    const yesPoints = values.yes || 0;
                    const noPoints = values.no || 0;
                    totals[game.id] += (clampedYes * yesPoints) + (noCount * noPoints);
                }
            });
        });
    });

    return games
        .filter((game) => (totals[game.id] >= 0))
        .map((game) => ({ id: game.id, name: game.name, score: totals[game.id] }))
        .sort((a, b) => b.score - a.score);
}

/**
 * Returns the top N highest-scoring games (restricted to `pool`) for a given
 * set of multi-player quiz answers.
 * @param {Object.<string, number>} yesCounts - map of question id -> number of players who answered yes.
 * @param {number} totalPlayers - total number of players who answered the quiz.
 * @param {Array<Object>} pool - subset of games to consider (e.g. those that fit the player count).
 * @param {number} topN
 * @returns {Array<{id: string, name: string, score: number}>}
 */
function getTopMatches(yesCounts, totalPlayers, pool = games, topN = 3) {
    const poolIds = new Set(pool.map((game) => game.id));
    return scoreGames(yesCounts, totalPlayers)
        .filter((game) => poolIds.has(game.id))
        .slice(0, topN);
}

function setStatus(el, text, className) {
    el.className = `status ${className || ''}`.trim();
    el.innerHTML = text;
}

function showSection(section) {
    [playerSection, quizSection, resultsSection].forEach((s) => {
        s.classList.toggle('hidden', s !== section);
    });
}

function renderQuiz() {
    quizHeadingEl.textContent = `For each question, how many of your ${numPlayers} player(s) answered "yes"?`;
    quizQuestionsEl.innerHTML = quiz.map((question, index) => `
        <div class="quiz-card">
            <span class="quiz-card-badge">Question ${index + 1} of ${quiz.length}</span>
            <p class="quiz-card-text">${question.text}</p>
            <div class="quiz-card-answer">
                <label for="q-${question.id}" class="quiz-answer-label">said yes:</label>
                <input type="number" id="q-${question.id}" data-question-id="${question.id}" min="0" max="${numPlayers}" step="1" value="0">
                <span class="quiz-answer-label">/ ${numPlayers}</span>
            </div>
        </div>
    `).join('');
    setStatus(quizStatusEl, '', '');
    showSection(quizSection);
}

function handlePlayerSubmit(event) {
    event.preventDefault();

    currentMatches = games;

    const parsedCount = parseInt(playerCountInput.value, 10);
    if (isNaN(parsedCount) || parsedCount < 1) {
        setStatus(playerStatusEl, 'Please enter a valid number of players.', 'error');
        return;
    }

    currentMatches = currentMatches.filter(
        (game) => parsedCount >= game.min_players && parsedCount <= game.max_players
    );

    if (currentMatches.length === 0) {
        const overallMin = Math.min(...games.map((game) => game.min_players));
        const overallMax = Math.max(...games.map((game) => game.max_players));
        setStatus(
            playerStatusEl,
            `No game supports ${parsedCount} player(s). Min player is ${overallMin} and max player is ${overallMax}. Please enter again.`,
            'error'
        );
        return;
    }

    numPlayers = parsedCount;
    
    const parsedMaxTime = parseInt(maxTimeInput.value, 10);
    if (isNaN(parsedMaxTime) || parsedMaxTime < 0) {
        setStatus(playerStatusEl, 'Please enter a valid max time to play.', 'error');
        return;
    }

    currentMatches = currentMatches.filter(
        (game) => parsedMaxTime >= game.min_avg_length_minutes
    );

    if (currentMatches.length === 0) {
        setStatus(
            playerStatusEl,
            `No game supports ${parsedCount} player(s) and ${parsedMaxTime} min average play time. Please enter again.`,
            'error'
        );
        return;
    }

    maxTime = parsedMaxTime;
    
    setStatus(playerStatusEl, '', '');
    renderQuiz();
}

function handleQuizSubmit(event) {
    event.preventDefault();

    const yesCounts = {};
    for (const question of quiz) {
        const inputEl = document.getElementById(`q-${question.id}`);
        const value = parseInt(inputEl.value, 10);
        if (isNaN(value) || value < 0 || value > numPlayers) {
            setStatus(quizStatusEl, `Please enter a number between 0 and ${numPlayers} for every question.`, 'error');
            return;
        }
        yesCounts[question.id] = value;
    }

    lastTopMatches = getTopMatches(yesCounts, numPlayers, currentMatches, 3);
    renderResults();
}

function renderResults() {
    if (lastTopMatches.length === 0) {
        resultsContentEl.innerHTML = '<p>No matches found. Please try again.</p>';
        showSection(resultsSection);
        return;
    }

    const topScore = lastTopMatches[0].score;
    const tiedTopIds = lastTopMatches
        .filter((match) => match.score === topScore)
        .map((match) => match.id);
    const pickedTopId = tiedTopIds[Math.floor(Math.random() * tiedTopIds.length)];

    const listItems = lastTopMatches.map((match) => `
        <li class="${match.id === pickedTopId ? 'top-pick' : ''}">
            <span>${match.id === pickedTopId ? '🎉 ' : ''}${match.name}</span>
            <span>score: ${match.score}</span>
        </li>
    `).join('');

    const shuffleBtn = tiedTopIds.length > 1
        ? '<button type="button" id="shuffle-top-btn">🎲 Shuffle Top Pick</button>'
        : '';

    resultsContentEl.innerHTML = `
        <p style="text-align:center; font-size:1.2rem;">Here's what your group should play:</p>
        <ul id="matches-list">${listItems}</ul>
        <div style="text-align:center;">${shuffleBtn}</div>
    `;

    const shuffleEl = document.getElementById('shuffle-top-btn');
    if (shuffleEl) {
        shuffleEl.addEventListener('click', renderResults);
    }

    showSection(resultsSection);
}

function resetToPlayerStep() {
    playerForm.reset();
    setStatus(playerStatusEl, '', '');
    setStatus(quizStatusEl, '', '');
    numPlayers = 0;
    maxTime = 0;
    currentMatches = [];
    lastTopMatches = [];
    showSection(playerSection);
}

playerForm.addEventListener('submit', handlePlayerSubmit);
quizForm.addEventListener('submit', handleQuizSubmit);
quizBackBtn.addEventListener('click', () => showSection(playerSection));
startOverBtn.addEventListener('click', resetToPlayerStep);

loadGames();
loadQuiz();
