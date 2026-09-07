const playerSection = document.getElementById('player-section');
const playerForm = document.getElementById('player-form');
const playerCountInput = document.getElementById('player-count');
const playerCountValueEl = document.getElementById('player-count-value');
const maxTimeInput = document.getElementById('max-time');
const maxTimeValueEl = document.getElementById('max-time-value');
const playerStatusEl = document.getElementById('player-status');

// The player-count slider's top value is just the largest headcount we
// bucket individually - unlike the time slider, this can't mean "no limit"
// (every player still needs their own personality-quiz screen and a
// concrete number feeds the count-fit scoring), so it's treated as a
// literal 20, labeled "20+" only as a hint that bigger groups get capped.
const PLAYER_COUNT_SLIDER_CAP = 20;

// The slider's top value stands in for "no limit" rather than a literal
// 240-minute cap, so marathon-length games stay reachable without needing
// an impractically long slider.
const MAX_TIME_SLIDER_CAP = 240;

function formatPlayerCountLabel(value) {
    const suffix = value >= PLAYER_COUNT_SLIDER_CAP ? '+' : '';
    return `${value}${suffix} player${value === 1 ? '' : 's'}`;
}

function formatMaxTimeLabel(value) {
    return value >= MAX_TIME_SLIDER_CAP ? `${MAX_TIME_SLIDER_CAP}+ min (no limit)` : `${value} min`;
}

playerCountInput.addEventListener('input', () => {
    playerCountValueEl.textContent = formatPlayerCountLabel(parseInt(playerCountInput.value, 10));
});

maxTimeInput.addEventListener('input', () => {
    maxTimeValueEl.textContent = formatMaxTimeLabel(parseInt(maxTimeInput.value, 10));
});

const quizSection = document.getElementById('quiz-section');
const quizHeadingEl = document.getElementById('quiz-heading');
const quizForm = document.getElementById('quiz-form');
const quizQuestionsEl = document.getElementById('quiz-questions');
const quizStatusEl = document.getElementById('quiz-status');
const quizBackBtn = document.getElementById('quiz-back-btn');
const quizSubmitBtn = document.getElementById('quiz-submit-btn');

const resultsSection = document.getElementById('results-section');
const resultsContentEl = document.getElementById('results-content');
const startOverBtn = document.getElementById('start-over-btn');
const gameNamesDatalist = document.getElementById('game-names-list');

// The 5 dimensions shared by every person vector and every game vector.
const TRAITS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];

// Amplifies negative individual scores so one player strongly disliking a
// game outweighs a plain sum/average across the rest of the group.
const MISERY_PENALTY_MULTIPLIER = 3;

// A named favorite/least-favorite game is treated as extra evidence about
// that player's OCEAN traits - the same category of signal as a TIPI answer
// - by blending the named game's own vector into (favorite) or away from
// (least-favorite) their personality vector before scoring. This is what
// makes the pull generalize to *similar* games, not just the one named.
// Starting values, not calibrated - a full 1.0 would let a single game
// pick dominate 10 TIPI answers entirely, so both are kept as a partial nudge.
const FAVORITE_GAME_BLEND_WEIGHT = 0.5;
const LEAST_FAVORITE_GAME_BLEND_WEIGHT = 0.5;

// On top of the vector blend above, a named favorite also gets a direct
// score bonus per player who named it (see getMatches) so it - specifically,
// not just games shaped like it - reliably surfaces rather than only
// nudging similar titles. A named least-favorite is removed from the
// candidate pool entirely for this session instead of merely penalized, so
// it's never re-suggested regardless of how well it'd otherwise score.
const FAVORITE_GAME_SCORE_BONUS_PER_PLAYER = 15;

// Maps each game.json genre tag to an OCEAN contribution.
// Sources, per tag, in order of confidence:
//   [Skillprint/GameDeveloper 2024] - a 500-gamer study rating 18 video game
//     genres against Big Five scores (word, puzzle, party, racing below are
//     taken directly from its reported genre associations).
//   [NEO-FFI board-game study, Danish/German/US sample, 2021] - found
//     Openness consistently predicts positive board-game attitudes/engagement
//     overall (used as directional support for strategy/deduction/adventure).
//   [extrapolated] - no direct study covered this tag; reasoned from the
//     tag's real-world play pattern (e.g. optimization-heavy genres skew
//     Conscientiousness). Weakest confidence tier.
// Neuroticism is left at 0 for every tag - none of the sources above found a
// reliable genre-level Neuroticism association for tabletop-style games.
const OCEAN_WEIGHTS = {
    'genres:cooperative': { a: 2 }, // [extrapolated] cooperative play = agreeableness
    'genres:strategy': { o: 1, c: 1 }, // [NEO-FFI]+[extrapolated]
    'genres:card': {}, // too generic a tag to carry signal on its own
    'genres:economy-building': { o: 1, c: 2 }, // [extrapolated] optimization-heavy
    'genres:deduction': { o: 2 }, // [NEO-FFI] openness/engagement proxy
    'genres:puzzle': { o: 2, a: 1 }, // [Skillprint] openness + agreeableness direct
    'genres:dice': { o: 1, c: -1 }, // [extrapolated] luck-tolerant, low-optimization
    'genres:family': { e: 1, a: 1, o: -1 }, // [extrapolated] accessible/casual proxy
    'genres:party': { e: 2, a: 1 }, // [Skillprint] extraversion + agreeableness direct
    'genres:civilization': { o: 1, c: 2 }, // [extrapolated] optimization-heavy
    'genres:adventure': { o: 2, e: 1 }, // [NEO-FFI]+[extrapolated]
    'genres:racing': { c: 1, e: 1 }, // [Skillprint] conscientiousness direct (note: opposite sign from an earlier untested guess)
    'genres:bluffing': { e: 1, a: -1 }, // [extrapolated] deception-oriented, low agreeableness
    'genres:word': { o: 2, c: 1, a: 1 }, // [Skillprint] openness + conscientiousness + agreeableness, all direct
};

// BoardGameGeek's "Weight" is the tabletop hobby's actual standard complexity
// metric: a community-voted 1.0 (Light) - 5.0 (Heavy) continuous rating.
// Centered on its 3.0 (Medium) midpoint and scaled per point of deviation -
// heavier games skew Openness (more willing to engage with dense rules) and
// Conscientiousness (more planning/optimization required) [NEO-FFI]+[extrapolated].
const WEIGHT_MIDPOINT = 3.0;
const OPENNESS_PER_WEIGHT_POINT = 0.6;
const CONSCIENTIOUSNESS_PER_WEIGHT_POINT = 0.5;

// How much a game's fit for the *current* player count matters, on top of
// personality fit. `ideal_players` in games.json is the game's real-world
// "sweet spot" (e.g. BGG community "Best With" consensus), which can differ
// from its hard min/max_players cutoffs already used to filter candidates
// (e.g. Codenames plays at 2, but is best at 6-8).
const COUNT_FIT_MIN_MULTIPLIER = 0.4;
const COUNT_FIT_DECAY_RATE = 0.3;

// Minimum *average per-player* final score (misery-penalized, count-fit
// applied) a game needs to count as a genuine recommendation, rather than
// just "the best of a bad set". Average (not the raw group sum used for
// ranking) so this bar is comparable across different group sizes - a bigger
// group's raw sum grows just from having more terms, which would otherwise
// make it easier to clear a fixed threshold regardless of actual fit.
// Used as a floor (see MIN_RECOMMENDATION_CEILING_FRACTION below) so a
// barely-positive ceiling can't let near-zero scores "qualify".
const MIN_RECOMMENDATION_AVG_SCORE = 10;

// The real qualifying bar is the larger of MIN_RECOMMENDATION_AVG_SCORE and
// this fraction of computeCeilingScore()'s avgScore for the current group.
// A single fixed absolute bar doesn't scale: once the library grew from
// ~84 to ~10,000 games, MIN_RECOMMENDATION_AVG_SCORE=3 alone let 1,300-6,700
// games "qualify" for any group with even a mild personality lean (measured
// directly against the real 9,935-game library) - not a meaningful
// recommendation anymore. A ceiling-relative bar self-calibrates instead:
// scaling a group's lean up or down scales its ceiling proportionally, so
// "reach 35% of your group's own best-case score" empirically produced a
// stable ~38-53 qualifying games across mild/moderate/strong/single-trait
// test profiles against the real library, rather than swinging by 100x.
const MIN_RECOMMENDATION_CEILING_FRACTION = 0.35;

// Hard safety cap on how many qualifying games are ever returned/rendered,
// independent of the threshold above - protects against a pathological case
// (or a future, much larger library) still producing an unrenderable list.
// getMatches reports the true qualifying count separately so the UI can say
// "showing top 60 of 140" rather than silently truncating.
const MAX_RENDERED_MATCHES = 30;

// Human-readable framing for each trait's high/low pole, used to describe a
// group's aggregate personality profile in plain language.
const TRAIT_DESCRIPTORS = {
    openness: { high: 'drawn to novel, complex ideas', low: 'prefers familiar, straightforward games' },
    conscientiousness: { high: 'inclined toward structured, planning-heavy strategy', low: 'inclined toward light, low-planning games' },
    extraversion: { high: 'social and outgoing', low: 'more reserved and low-key' },
    agreeableness: { high: 'cooperative and team-oriented', low: 'comfortable with head-to-head competition' },
    neuroticism: { high: 'sensitive to tense or high-pressure moments', low: 'unfazed by tension or pressure' },
};

const TRAIT_DISPLAY_NAMES = {
    openness: 'Openness',
    conscientiousness: 'Conscientiousness',
    extraversion: 'Extraversion',
    agreeableness: 'Agreeableness',
    neuroticism: 'Neuroticism',
};

// How far apart the most- and least-strongly-scored players can be on a
// trait (out of a max possible 6, from -3 to +3) before it's called out as
// something the group genuinely disagrees on, rather than just averaged over.
const TRAIT_SPREAD_SPLIT_THRESHOLD = 2.5;

const SLIDER_LABELS = {
    1: 'Disagree strongly',
    2: 'Disagree',
    3: 'Disagree a little',
    4: 'Neutral',
    5: 'Agree a little',
    6: 'Agree',
    7: 'Agree strongly',
};

let games = [];
let tipiItems = [];
let numPlayers = 0;
let maxTime = 0;
let currentMatches = [];
let currentPlayerIndex = 0;
let personVectors = [];
// Parallel to personVectors - the game object each player named as their
// favorite/least-favorite this session, or null if they skipped it/typed
// something that didn't match a game in the library.
let favoriteGamePicks = [];
let leastFavoriteGamePicks = [];
let lastMatchResult = { qualifies: true, matches: [] };

async function loadGames() {
    try {
        const response = await fetch('games.json');
        games = await response.json();
        populateGameNamesDatalist();
    } catch (err) {
        setStatus(playerStatusEl, 'Could not load games.json. If you opened this file directly (file://), please serve it via a local server or view it through GitHub Pages instead.', 'error');
    }
}

// Escapes text for safe use inside an HTML attribute value (e.g. <option
// value="...">) - narrower than full HTML-escaping, but that's all a
// datalist option's value attribute needs.
function escapeHtmlAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Powers the "favorite/least-favorite game" autocomplete inputs in the quiz
// - built once from the full library right after it loads, rather than
// rebuilt on every per-player quiz render.
function populateGameNamesDatalist() {
    if (!gameNamesDatalist) return;
    gameNamesDatalist.innerHTML = games
        .map((game) => `<option value="${escapeHtmlAttr(game.name)}"></option>`)
        .join('');
}

// Resolves free-typed text against the loaded game library by exact,
// case-insensitive name match (the datalist encourages picking a real name,
// but doesn't enforce it) - returns null for blank/unmatched input, since
// the favorite/least-favorite questions are optional.
function findGameByName(name) {
    if (!name) return null;
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return null;
    return games.find((game) => game.name && game.name.toLowerCase() === trimmed) || null;
}

// Treats a named favorite/least-favorite game as extra evidence about a
// player's OCEAN traits, blending its own game-vector into (or away from)
// their personality vector before it ever reaches scoring - see the
// FAVORITE_GAME_BLEND_WEIGHT comment above for why this generalizes to
// similar games rather than just the one named.
function applyGamePreferenceBlend(personVector, favoriteGame, leastFavoriteGame) {
    const vector = { ...personVector };
    if (favoriteGame) {
        const favoriteVector = computeGameVector(favoriteGame);
        TRAITS.forEach((trait) => {
            vector[trait] += FAVORITE_GAME_BLEND_WEIGHT * favoriteVector[trait];
        });
    }
    if (leastFavoriteGame) {
        const leastFavoriteVector = computeGameVector(leastFavoriteGame);
        TRAITS.forEach((trait) => {
            vector[trait] -= LEAST_FAVORITE_GAME_BLEND_WEIGHT * leastFavoriteVector[trait];
        });
    }
    return vector;
}

async function loadTipi() {
    try {
        const response = await fetch('tipi.json');
        tipiItems = await response.json();
    } catch (err) {
        console.error('Could not load tipi.json.', err);
    }
}

function zeroVector() {
    return { openness: 0, conscientiousness: 0, extraversion: 0, agreeableness: 0, neuroticism: 0 };
}

function addVectors(a, b) {
    const sum = zeroVector();
    TRAITS.forEach((trait) => {
        sum[trait] = a[trait] + b[trait];
    });
    return sum;
}

function weightVector(weights) {
    const { o = 0, c = 0, e = 0, a = 0, n = 0 } = weights || {};
    return { openness: o, conscientiousness: c, extraversion: e, agreeableness: a, neuroticism: n };
}

/**
 * Derives a game's OCEAN vector from its genres (via the cited OCEAN_WEIGHTS
 * table) plus its BGG-style numeric `weight` (via a continuous formula
 * centered on the standard 1.0-5.0 scale's midpoint).
 */
function computeGameVector(game) {
    let vector = zeroVector();
    (game.genres || []).forEach((genre) => {
        vector = addVectors(vector, weightVector(OCEAN_WEIGHTS[`genres:${genre}`]));
    });
    const weightDeviation = (game.weight || WEIGHT_MIDPOINT) - WEIGHT_MIDPOINT;
    vector = addVectors(vector, weightVector({
        o: weightDeviation * OPENNESS_PER_WEIGHT_POINT,
        c: weightDeviation * CONSCIENTIOUSNESS_PER_WEIGHT_POINT,
    }));
    return vector;
}

/**
 * Turns one player's 10 raw answers (1-7 each) into a centered 5-dim OCEAN
 * vector, using the standard TIPI reverse-scoring formula (2 items per
 * trait, reverse-keyed items rescored as 8 - rawScore, then centered on the
 * 1-7 midpoint so "neutral" contributes exactly 0).
 * @param {Object.<string, number>} answers - map of tipi item id -> raw 1-7 answer.
 */
function computePersonVector(answers) {
    const traitSums = {};
    const traitCounts = {};
    TRAITS.forEach((trait) => {
        traitSums[trait] = 0;
        traitCounts[trait] = 0;
    });

    tipiItems.forEach((item) => {
        const raw = answers[item.id];
        if (typeof raw !== 'number' || Number.isNaN(raw)) {
            return;
        }
        const score = item.reverse ? 8 - raw : raw;
        traitSums[item.trait] += score;
        traitCounts[item.trait] += 1;
    });

    const personVector = zeroVector();
    TRAITS.forEach((trait) => {
        const count = traitCounts[trait] || 1;
        const average = traitSums[trait] / count;
        personVector[trait] = average - 4; // center the 1-7 scale so "neutral" contributes 0
    });
    return personVector;
}

function dot(vectorA, vectorB) {
    return TRAITS.reduce((sum, trait) => sum + vectorA[trait] * vectorB[trait], 0);
}

function magnitude(vector) {
    return Math.sqrt(TRAITS.reduce((sum, trait) => sum + vector[trait] * vector[trait], 0));
}

/**
 * Turns one trait's average centered value (-3..+3) into a plain-language
 * fragment, e.g. "very social and outgoing". Returns null for values close
 * to neutral, so the overall description only calls out traits that
 * actually stand out.
 */
function describeTraitLevel(trait, value) {
    const descriptors = TRAIT_DESCRIPTORS[trait];
    if (value >= 1.5) return `very ${descriptors.high}`;
    if (value >= 0.5) return `somewhat ${descriptors.high}`;
    if (value <= -1.5) return `very much ${descriptors.low}`;
    if (value <= -0.5) return `somewhat ${descriptors.low}`;
    return null;
}

/**
 * Plain-language summary of the whole group's aggregate OCEAN profile
 * (average of each player's centered TIPI vector), so results read as
 * "here's who we think you are" rather than a black-box score.
 */
function describeGroupProfile(playerVectors) {
    if (playerVectors.length === 0) {
        return '';
    }
    const n = playerVectors.length;
    const avgVector = zeroVector();
    playerVectors.forEach((vector) => {
        TRAITS.forEach((trait) => { avgVector[trait] += vector[trait] / n; });
    });

    const parts = TRAITS
        .map((trait) => describeTraitLevel(trait, avgVector[trait]))
        .filter(Boolean);

    if (parts.length === 0) {
        return "As a group, your personalities are fairly balanced across the board - no single trait stands out strongly.";
    }
    return `As a group, you come across as ${parts.join(', ')}.`;
}

/**
 * Explains *why* no game cleared MIN_RECOMMENDATION_AVG_SCORE, beyond just
 * "scores were too low". Distinguishes two real, different causes visible in
 * the data: the group individually leans strongly in different directions
 * (personalities disagree, so the average washes out even though each
 * person has real preferences), vs. the group is just broadly neutral (no
 * one has strong enough preferences either way to clear the bar).
 */
function describeNoMatchReason(playerVectors) {
    if (playerVectors.length < 2) {
        return 'None of the available games (within your headcount and time filters) scored high enough to call a strong match - try adjusting your max time, or trying again.';
    }

    const n = playerVectors.length;
    const avgVector = zeroVector();
    playerVectors.forEach((vector) => {
        TRAITS.forEach((trait) => { avgVector[trait] += vector[trait] / n; });
    });

    const avgIndividualMagnitude = playerVectors.reduce((sum, vector) => sum + magnitude(vector), 0) / n;
    const groupMagnitude = magnitude(avgVector);

    if (avgIndividualMagnitude > 0.5 && groupMagnitude < avgIndividualMagnitude * 0.5) {
        return "This looks less like a lack of good games, and more like your group has quite different personalities from each other - individually you each lean fairly strongly one way or another, but those leanings pull against each other, so nothing appeals broadly to everyone at once.";
    }
    return "Your group's personalities are fairly neutral/balanced overall, so most games scored close to a wash rather than a clear win, within your current headcount and time filters.";
}

/**
 * Like describeTraitLevel, but never returns null - "Balanced / neutral"
 * fills in near-zero values, since a full per-trait breakdown should show
 * every trait, not just the ones that stand out.
 */
function traitLevelLabel(trait, value) {
    const level = describeTraitLevel(trait, value);
    if (!level) {
        return 'Balanced / neutral';
    }
    return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Maps a centered trait value (-3..+3) to a 0-100% position for the bar UI. */
function traitValueToPercent(value) {
    return Math.max(0, Math.min(100, ((value + 3) / 6) * 100));
}

/**
 * Full per-trait, per-player breakdown of the group's personalities: for
 * each of the 5 OCEAN traits, the group's average level (always shown, even
 * when neutral) plus whether individual players actually disagree on it
 * (a wide spread between the highest- and lowest-scoring player); then a
 * one-line profile for each individual player. Everything here is derived
 * directly from the same centered TIPI vectors already used for scoring -
 * no new data or authored content.
 */
function renderTraitBreakdownHtml(playerVectors) {
    const n = playerVectors.length;

    const traitRows = TRAITS.map((trait) => {
        const values = playerVectors.map((vector) => vector[trait]);
        const avg = values.reduce((sum, value) => sum + value, 0) / n;
        const spread = Math.max(...values) - Math.min(...values);
        const splitNote = spread >= TRAIT_SPREAD_SPLIT_THRESHOLD
            ? '<span class="trait-split-note">Group is split on this one</span>'
            : '';
        return `
            <div class="trait-row">
                <div class="trait-row-header">
                    <span class="trait-name">${TRAIT_DISPLAY_NAMES[trait]}</span>
                    <span class="trait-level">${traitLevelLabel(trait, avg)}</span>
                </div>
                <div class="trait-bar-track"><div class="trait-bar-marker" style="left:${traitValueToPercent(avg)}%"></div></div>
                ${splitNote}
            </div>
        `;
    }).join('');

    const playerLines = playerVectors.map((vector, index) => {
        const parts = TRAITS.map((trait) => describeTraitLevel(trait, vector[trait])).filter(Boolean);
        const text = parts.length > 0 ? parts.join(', ') : 'a fairly balanced personality across the board';
        return `<li><strong>Player ${index + 1}:</strong> ${text}</li>`;
    }).join('');

    return `
        <details class="trait-breakdown" open>
            <summary>Detailed personality breakdown</summary>
            <div class="trait-breakdown-body">
                ${traitRows}
                <h4 class="player-breakdown-heading">By player</h4>
                <ul class="player-breakdown-list">${playerLines}</ul>
            </div>
        </details>
    `;
}

// Game vectors (see computeGameVector) are raw sums of small per-genre
// integer weights plus a continuous weight-based term - a different scale
// from the centered, per-player TIPI vectors (-3..+3) - so describing a
// game's own lean needs its own thresholds, tuned against that raw scale.
const GAME_TRAIT_STRONG_THRESHOLD = 2.5;
const GAME_TRAIT_MODERATE_THRESHOLD = 1;

/**
 * Turns one trait's raw game-vector value into a plain-language fragment
 * describing the *game's* own lean (not a person's), e.g. "enjoys
 * structured, planning-heavy strategy". Returns null when the game carries
 * no real signal on that trait, so only traits the game actually leans on
 * show up.
 */
function describeGameTraitLevel(trait, value) {
    const descriptors = TRAIT_DESCRIPTORS[trait];
    if (value >= GAME_TRAIT_STRONG_THRESHOLD) return descriptors.high;
    if (value >= GAME_TRAIT_MODERATE_THRESHOLD) return `somewhat ${descriptors.high}`;
    if (value <= -GAME_TRAIT_STRONG_THRESHOLD) return descriptors.low;
    if (value <= -GAME_TRAIT_MODERATE_THRESHOLD) return `somewhat ${descriptors.low}`;
    return null;
}

/**
 * Plain-language summary of a single game's own OCEAN profile, derived the
 * same way as its scoring vector (genres + BGG weight). Neuroticism is
 * skipped - OCEAN_WEIGHTS never assigns it at the genre level, so it's
 * always exactly 0 and carries no signal to describe.
 */
function describeGameProfile(game) {
    const vector = computeGameVector(game);
    const parts = TRAITS
        .filter((trait) => trait !== 'neuroticism')
        .map((trait) => describeGameTraitLevel(trait, vector[trait]))
        .filter(Boolean);
    if (parts.length === 0) {
        return 'a fairly all-purpose game with no strong personality lean either way';
    }
    return parts.join(', ');
}

/**
 * Explains *why* this particular game scored well for this particular
 * group: finds the 1-2 traits where the group's average lean and the
 * game's own lean multiply together into the largest positive contribution
 * - literally the dominant terms behind the dot-product score - and
 * describes them using the group's own trait language (describeTraitLevel),
 * so the explanation traces back to real numbers rather than being generic.
 */
function describeMatchReason(game, playerVectors) {
    if (playerVectors.length === 0) {
        return '';
    }
    const gameVector = computeGameVector(game);
    const n = playerVectors.length;
    const avgPersonVector = zeroVector();
    playerVectors.forEach((vector) => {
        TRAITS.forEach((trait) => { avgPersonVector[trait] += vector[trait] / n; });
    });

    const contributions = TRAITS
        .filter((trait) => trait !== 'neuroticism')
        .map((trait) => ({
            trait,
            contribution: avgPersonVector[trait] * gameVector[trait],
            groupLevel: describeTraitLevel(trait, avgPersonVector[trait]),
        }))
        .filter((entry) => entry.contribution > 0.3 && entry.groupLevel)
        .sort((a, b) => b.contribution - a.contribution);

    if (contributions.length === 0) {
        return "Scored well mostly on player-count fit rather than a strong personality pull either way.";
    }

    const phrases = contributions.slice(0, 2).map((entry) => `your group is ${entry.groupLevel}`);
    return `Good fit because ${phrases.join(', and ')} - a trait this game rewards.`;
}

/**
 * Assembles the "what it's about / best with / traits / why this matches"
 * detail block shown under each recommended or close-match game.
 */
function renderGameDetailsHtml(sourceGame) {
    if (!sourceGame) {
        return '';
    }
    const descriptionHtml = sourceGame.description
        ? `<p class="game-card-description">${sourceGame.description}</p>`
        : '';
    return `
        ${descriptionHtml}
        <p class="game-card-meta"><strong>Best with:</strong> ${formatIdealPlayers(sourceGame)}</p>
        <p class="game-card-meta"><strong>This game leans toward players who are:</strong> ${describeGameProfile(sourceGame)}</p>
        <p class="game-card-reason"><strong>Why this matches your group:</strong> ${describeMatchReason(sourceGame, personVectors)}</p>
    `;
}

/**
 * Amplifies negative scores so a player who would genuinely dislike a game
 * weighs more heavily than the raw sum/average would allow.
 */
function adjustedScore(rawScore) {
    return rawScore >= 0 ? rawScore : rawScore * MISERY_PENALTY_MULTIPLIER;
}

/**
 * How well a game fits the current player count, as a soft multiplier in
 * (COUNT_FIT_MIN_MULTIPLIER, 1]. 1 means `n` is inside (or equal to) the
 * game's `ideal_players` sweet spot; it decays linearly the further `n`
 * strays from that spot, floored at COUNT_FIT_MIN_MULTIPLIER so an
 * off-count game is never zeroed out entirely (min/max_players filtering
 * already handles hard cutoffs elsewhere).
 */
function computeCountMultiplier(game, n) {
    const ideal = game.ideal_players;
    if (!ideal || ideal.length === 0) {
        return 1;
    }
    const idealMin = Math.min(...ideal);
    const idealMax = Math.max(...ideal);
    const distance = n >= idealMin && n <= idealMax
        ? 0
        : Math.min(Math.abs(n - idealMin), Math.abs(n - idealMax));
    return Math.max(COUNT_FIT_MIN_MULTIPLIER, 1 - COUNT_FIT_DECAY_RATE * distance);
}

/**
 * Applies the count-fit multiplier to a (misery-penalized) score. A plain
 * `score * multiplier` would be wrong for negative scores: shrinking a
 * negative number toward 0 makes a poor count-fit look like an *improvement*,
 * the opposite of intent. Dividing instead when score < 0 keeps both
 * directions consistent: a game that's both a poor personality fit and a
 * poor count fit should always rank worse than one that's just a poor
 * personality fit, never better.
 */
function applyCountFit(score, multiplier) {
    return score >= 0 ? score * multiplier : score / multiplier;
}

/**
 * Scores every game in `pool` for the whole group: each player's centered
 * OCEAN vector is dotted with the game's OCEAN vector, misery-penalized,
 * summed across all players, then adjusted by how well the game fits this
 * many players. Returns both the raw group sum (`score`, used for ranking -
 * a game pleasing more people should out-score one thrilling fewer) and the
 * per-player average (`avgScore`, `personalityAvgScore` before the count-fit
 * adjustment - used for the qualification threshold, since averages are
 * comparable across different group sizes while sums aren't).
 * @param {Array<Object>} playerVectors - one centered OCEAN vector per player.
 * @param {Array<Object>} pool - subset of games to consider.
 */
function scoreGames(playerVectors, pool) {
    const n = playerVectors.length || 1;
    return pool
        .map((game) => {
            const gameVector = computeGameVector(game);
            const personalityTotal = playerVectors.reduce(
                (sum, personVector) => sum + adjustedScore(dot(personVector, gameVector)),
                0
            );
            const countMultiplier = computeCountMultiplier(game, playerVectors.length);
            const total = applyCountFit(personalityTotal, countMultiplier);
            return {
                id: game.id,
                name: game.name,
                score: total,
                avgScore: total / n,
                personalityAvgScore: personalityTotal / n,
            };
        })
        .sort((a, b) => b.score - a.score);
}

/**
 * Finds the hypothetical game with the greatest possible score under the
 * actual scoring model. The model allows any combination of known genre tags
 * and any BGG weight from 1.0 through 5.0; it intentionally ignores whether
 * such a combination exists in the real catalogue.
 *
 * This must optimize each player's misery-penalized score, not the group's
 * raw dot product. A genre that is slightly positive for the group total can
 * still be a net loss once one player's negative reaction is tripled. There
 * are only 14 genre tags, so exhaustively testing every subset is small and
 * gives an exact result. For a fixed subset, the score is piecewise linear in
 * weight: its only possible maxima are at 1.0, 5.0, or where a player's raw
 * score crosses zero. Testing those points makes the continuous weight search
 * exact as well.
 */
function computeCeilingGame(playerVectors, n) {
    const genreOptions = Object.entries(OCEAN_WEIGHTS).map(([key, weights]) => ({
        genre: key.slice('genres:'.length),
        vector: weightVector(weights),
    }));
    let bestGame = null;
    let bestScore = -Infinity;

    for (let mask = 0; mask < (1 << genreOptions.length); mask += 1) {
        let genreVector = zeroVector();
        const genres = [];
        genreOptions.forEach((option, index) => {
            if (mask & (1 << index)) {
                genres.push(option.genre);
                genreVector = addVectors(genreVector, option.vector);
            }
        });

        const candidateWeights = new Set([1, 5]);
        playerVectors.forEach((personVector) => {
            const weightSlope = (personVector.openness * OPENNESS_PER_WEIGHT_POINT)
                + (personVector.conscientiousness * CONSCIENTIOUSNESS_PER_WEIGHT_POINT);
            if (weightSlope === 0) return;
            const zeroCrossingWeight = WEIGHT_MIDPOINT - dot(personVector, genreVector) / weightSlope;
            if (zeroCrossingWeight >= 1 && zeroCrossingWeight <= 5) {
                candidateWeights.add(zeroCrossingWeight);
            }
        });

        candidateWeights.forEach((weight) => {
            const weightDeviation = weight - WEIGHT_MIDPOINT;
            const gameVector = addVectors(genreVector, weightVector({
                o: weightDeviation * OPENNESS_PER_WEIGHT_POINT,
                c: weightDeviation * CONSCIENTIOUSNESS_PER_WEIGHT_POINT,
            }));
            const score = playerVectors.reduce(
                (sum, personVector) => sum + adjustedScore(dot(personVector, gameVector)),
                0
            );
            if (score > bestScore) {
                bestScore = score;
                bestGame = { genres: [...genres], weight };
            }
        });
    }

    return {
        id: '__ceiling__',
        name: 'a perfectly-tailored game',
        ...bestGame,
        ideal_players: [n],
    };
}

/**
 * Runs the ceiling game through the real scoreGames() pipeline (misery
 * penalty included) so its score is directly comparable to real matches.
 */
function computeCeilingScore(playerVectors) {
    const n = playerVectors.length || 1;
    const ceilingGame = computeCeilingGame(playerVectors, n);
    return scoreGames(playerVectors, [ceilingGame])[0];
}

function formatIdealPlayers(game) {
    if (!game || !game.ideal_players || game.ideal_players.length === 0) {
        return 'a different number of players';
    }
    const idealMin = Math.min(...game.ideal_players);
    const idealMax = Math.max(...game.ideal_players);
    return idealMin === idealMax ? `${idealMin} players` : `${idealMin}-${idealMax} players`;
}

/**
 * Splits scored games into genuine recommendations (average per-player score
 * at/above the ceiling-relative bar - see MIN_RECOMMENDATION_CEILING_FRACTION)
 * and, when none clear that bar, a short "closest we found" fallback list
 * instead - each annotated with why it fell short, so a game whose
 * *personality* fit was strong but got dragged below threshold purely by a
 * bad player-count fit reads differently from one that was just never a
 * strong match to begin with.
 * @param {Array<Object>} playerVectors - one centered OCEAN vector per player.
 * @param {Array<Object>} pool - subset of games to consider.
 * @param {number} fallbackCount - max number of results to show only in the
 *   no-qualifying-match fallback case.
 * @param {Array<Object|null>} favoritePicks - one game-or-null per player,
 *   from the optional "favorite game" question.
 * @param {Array<Object|null>} leastFavoritePicks - same shape, for the
 *   optional "least favorite game" question.
 */
function getMatches(playerVectors, pool, fallbackCount = 5, favoritePicks = [], leastFavoritePicks = []) {
    // A named least-favorite is removed from the pool entirely - we never
    // re-suggest it this session, regardless of how well it'd otherwise
    // score (its *personality* pull already happened via the vector blend
    // in applyGamePreferenceBlend, which still affects similar games).
    const leastFavoriteIds = new Set(
        leastFavoritePicks.filter(Boolean).map((game) => game.id)
    );
    const eligiblePool = pool.filter((game) => !leastFavoriteIds.has(game.id));

    // A named favorite gets a direct score bonus per player who named it,
    // so it - specifically, not just games shaped like it - reliably
    // surfaces. Applied post-scoring so it never touches personalityAvgScore
    // (the fallback "great personality fit, wrong headcount" reasoning below
    // should stay about personality fit alone).
    const favoriteMentionCounts = {};
    favoritePicks.filter(Boolean).forEach((game) => {
        favoriteMentionCounts[game.id] = (favoriteMentionCounts[game.id] || 0) + 1;
    });

    const allScored = scoreGames(playerVectors, eligiblePool)
        .map((game) => {
            const mentions = favoriteMentionCounts[game.id] || 0;
            if (mentions === 0) return game;
            const n = playerVectors.length || 1;
            const boostedScore = game.score + mentions * FAVORITE_GAME_SCORE_BONUS_PER_PLAYER;
            return { ...game, score: boostedScore, avgScore: boostedScore / n };
        })
        .sort((a, b) => b.score - a.score);
    const ceiling = computeCeilingScore(playerVectors);
    const qualifyingBar = Math.max(MIN_RECOMMENDATION_AVG_SCORE, MIN_RECOMMENDATION_CEILING_FRACTION * ceiling.avgScore);
    const qualifying = allScored.filter((game) => game.avgScore >= qualifyingBar);

    if (qualifying.length > 0) {
        return {
            qualifies: true,
            matches: qualifying.slice(0, MAX_RENDERED_MATCHES),
            totalQualifying: qualifying.length,
        };
    }

    const closest = allScored.slice(0, fallbackCount).map((game) => {
        const sourceGame = pool.find((g) => g.id === game.id);
        const reason = game.personalityAvgScore >= qualifyingBar
            ? `Your group's personalities are a great match for this one - it's just not the right headcount (best with ${formatIdealPlayers(sourceGame)}).`
            : `Closest option we found, though it's not a strong personality fit for your group either.`;
        return { ...game, reason };
    });
    return { qualifies: false, matches: closest, totalQualifying: 0 };
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

function renderPersonalityQuiz() {
    quizHeadingEl.innerHTML = `Player ${currentPlayerIndex + 1} of ${numPlayers}` +
        '<br><span class="quiz-subheading">Pass the device to this player - answer honestly about yourself</span>';

    quizQuestionsEl.innerHTML = tipiItems.map((item, index) => `
        <div class="quiz-card">
            <span class="quiz-card-badge">Statement ${index + 1} of ${tipiItems.length}</span>
            <p class="quiz-card-text">${item.text}</p>
            <div class="tipi-slider-row">
                <span class="tipi-slider-endlabel">Disagree<br>strongly</span>
                <input type="range" class="tipi-slider unanswered" min="1" max="7" step="1" value="4" data-item-id="${item.id}" data-touched="false">
                <span class="tipi-slider-endlabel">Agree<br>strongly</span>
            </div>
            <div class="tipi-slider-value unanswered" id="tipi-value-${item.id}">Not answered yet - click or drag the slider</div>
        </div>
    `).join('') + `
        <div class="quiz-card game-pref-card">
            <p class="quiz-card-text">Optional: what's your favorite board game?</p>
            <input type="text" class="game-pref-input" id="favorite-game-input" list="game-names-list" placeholder="Start typing a game name..." autocomplete="off">
            <p class="game-pref-hint">Helps us find more games like it for you.</p>
        </div>
        <div class="quiz-card game-pref-card">
            <p class="quiz-card-text">Optional: what's your least favorite board game?</p>
            <input type="text" class="game-pref-input" id="least-favorite-game-input" list="game-names-list" placeholder="Start typing a game name..." autocomplete="off">
            <p class="game-pref-hint">We'll steer away from it and games like it.</p>
        </div>
    `;

    quizQuestionsEl.querySelectorAll('.tipi-slider').forEach((slider) => {
        // A plain click on the thumb (no drag) doesn't change the value, so
        // it never fires 'input' - but it should still count as "I meant to
        // leave this at neutral", not force a drag just to register an
        // answer. 'pointerdown' covers mouse/touch/pen clicks; 'input'
        // still handles real drags and keyboard (arrow key) changes.
        const markAnswered = () => {
            slider.dataset.touched = 'true';
            slider.classList.remove('unanswered');
            const valueEl = document.getElementById(`tipi-value-${slider.dataset.itemId}`);
            valueEl.classList.remove('unanswered');
            valueEl.textContent = `${slider.value} - ${SLIDER_LABELS[slider.value]}`;
        };
        slider.addEventListener('input', markAnswered);
        slider.addEventListener('pointerdown', markAnswered);
    });

    quizSubmitBtn.textContent = currentPlayerIndex + 1 === numPlayers ? 'See Our Matches' : 'Next Player →';
    setStatus(quizStatusEl, '', '');
    showSection(quizSection);
}

function handlePlayerSubmit(event) {
    event.preventDefault();

    currentMatches = games;

    const parsedCount = parseInt(playerCountInput.value, 10);

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

    const sliderMaxTime = parseInt(maxTimeInput.value, 10);
    const parsedMaxTime = sliderMaxTime >= MAX_TIME_SLIDER_CAP ? Infinity : sliderMaxTime;

    currentMatches = currentMatches.filter(
        (game) => parsedMaxTime >= game.min_avg_length_minutes
    );

    if (currentMatches.length === 0) {
        setStatus(
            playerStatusEl,
            `No game supports ${parsedCount} player(s) and ${formatMaxTimeLabel(sliderMaxTime)} average play time. Please enter again.`,
            'error'
        );
        return;
    }

    maxTime = parsedMaxTime;

    setStatus(playerStatusEl, '', '');
    currentPlayerIndex = 0;
    personVectors = [];
    favoriteGamePicks = [];
    leastFavoriteGamePicks = [];
    renderPersonalityQuiz();
}

function handleQuizSubmit(event) {
    event.preventDefault();

    const sliders = Array.from(quizQuestionsEl.querySelectorAll('.tipi-slider'));
    const hasUntouched = sliders.some((slider) => slider.dataset.touched !== 'true');
    if (hasUntouched) {
        setStatus(quizStatusEl, 'Please answer every statement by clicking or dragging its slider - even if your honest answer is neutral.', 'error');
        return;
    }

    const answers = {};
    sliders.forEach((slider) => {
        answers[slider.dataset.itemId] = parseInt(slider.value, 10);
    });

    const favoriteGame = findGameByName(document.getElementById('favorite-game-input').value);
    const leastFavoriteGame = findGameByName(document.getElementById('least-favorite-game-input').value);
    favoriteGamePicks.push(favoriteGame);
    leastFavoriteGamePicks.push(leastFavoriteGame);

    const rawVector = computePersonVector(answers);
    personVectors.push(applyGamePreferenceBlend(rawVector, favoriteGame, leastFavoriteGame));

    if (currentPlayerIndex + 1 < numPlayers) {
        currentPlayerIndex += 1;
        renderPersonalityQuiz();
        return;
    }

    lastMatchResult = getMatches(personVectors, currentMatches, 5, favoriteGamePicks, leastFavoriteGamePicks);
    renderResults();
}

/**
 * Renders the "how good could this get, in theory" reference line - see
 * computeCeilingScore(). topScore is whatever the best real option actually
 * reached (qualifying or fallback), so this always reads as a comparison,
 * not an isolated abstract number.
 */
function renderCeilingHtml(playerVectors, topScore) {
    const ceiling = computeCeilingScore(playerVectors);
    if (ceiling.score <= 0) {
        return `<p class="ceiling-note">Your group's preferences don't lean strongly in any one direction, so even a perfectly-tailored game wouldn't score dramatically higher than what you see below.</p>`;
    }
    // Clamped at 100%: the ceiling is a very good but not mathematically
    // exact upper bound (it optimizes the pre-misery-penalty linear sum,
    // which is usually but not always identical to the true misery-penalized
    // optimum), so a real game could in rare cases edge past it slightly.
    const pctOfCeiling = Math.min(100, Math.round((100 * topScore) / ceiling.score));
    return `<p class="ceiling-note">The best possible score for a group like yours - if a perfectly-tailored game existed - is about ${ceiling.score.toFixed(1)} (avg ${ceiling.avgScore.toFixed(1)}/player). Your best real option reaches ${pctOfCeiling}% of that ceiling.</p>`;
}

function renderResults() {
    const { qualifies, matches, totalQualifying } = lastMatchResult;
    const groupProfileHtml = `<p class="group-profile">${describeGroupProfile(personVectors)}</p>`;
    const traitBreakdownHtml = renderTraitBreakdownHtml(personVectors);

    if (matches.length === 0) {
        resultsContentEl.innerHTML = `${groupProfileHtml}${traitBreakdownHtml}<p>No matches found. Please try again.</p>`;
        showSection(resultsSection);
        return;
    }

    const ceilingHtml = renderCeilingHtml(personVectors, matches[0].score);

    if (!qualifies) {
        const listItems = matches.map((match) => {
            const sourceGame = currentMatches.find((game) => game.id === match.id);
            return `
                <li>
                    <div class="close-match-row">
                        <span>${match.name}</span>
                        <span>score: ${match.score.toFixed(1)}</span>
                    </div>
                    <p class="close-match-reason">${match.reason}</p>
                    ${renderGameDetailsHtml(sourceGame)}
                </li>
            `;
        }).join('');

        resultsContentEl.innerHTML = `
            ${groupProfileHtml}
            ${traitBreakdownHtml}
            ${ceilingHtml}
            <p style="text-align:center; font-size:1.2rem;">We couldn't find a strong match for your group - here's the closest we've got:</p>
            <p class="no-match-reason">${describeNoMatchReason(personVectors)}</p>
            <ul id="matches-list" class="close-matches">${listItems}</ul>
        `;
        showSection(resultsSection);
        return;
    }

    const topScore = matches[0].score;
    const tiedTopIds = matches
        .filter((match) => match.score === topScore)
        .map((match) => match.id);
    const pickedTopId = tiedTopIds[Math.floor(Math.random() * tiedTopIds.length)];

    const listItems = matches.map((match) => {
        const sourceGame = currentMatches.find((game) => game.id === match.id);
        return `
            <li class="${match.id === pickedTopId ? 'top-pick' : ''}">
                <div class="game-card-header">
                    <span>${match.id === pickedTopId ? '🎉 ' : ''}${match.name}</span>
                    <span>score: ${match.score.toFixed(1)}</span>
                </div>
                ${renderGameDetailsHtml(sourceGame)}
            </li>
        `;
    }).join('');

    const shuffleBtn = tiedTopIds.length > 1
        ? '<button type="button" id="shuffle-top-btn">🎲 Shuffle Top Pick</button>'
        : '';

    const matchCountNote = totalQualifying > matches.length
        ? `${totalQualifying} games cleared our recommendation bar for your group - showing the top ${matches.length}, best first.`
        : matches.length === 1
            ? '1 game cleared our recommendation bar for your group.'
            : `${matches.length} games cleared our recommendation bar for your group, best first.`;

    resultsContentEl.innerHTML = `
        ${groupProfileHtml}
        ${traitBreakdownHtml}
        ${ceilingHtml}
        <p style="text-align:center; font-size:1.2rem;">Here's what your group should play:</p>
        <p style="text-align:center; font-size:0.9rem; color:#555;">${matchCountNote}</p>
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
    playerCountValueEl.textContent = formatPlayerCountLabel(parseInt(playerCountInput.value, 10));
    maxTimeValueEl.textContent = formatMaxTimeLabel(parseInt(maxTimeInput.value, 10));
    setStatus(playerStatusEl, '', '');
    setStatus(quizStatusEl, '', '');
    numPlayers = 0;
    maxTime = 0;
    currentMatches = [];
    currentPlayerIndex = 0;
    personVectors = [];
    favoriteGamePicks = [];
    leastFavoriteGamePicks = [];
    lastMatchResult = { qualifies: true, matches: [] };
    showSection(playerSection);
}

playerForm.addEventListener('submit', handlePlayerSubmit);
quizForm.addEventListener('submit', handleQuizSubmit);
quizBackBtn.addEventListener('click', () => {
    if (currentPlayerIndex > 0) {
        currentPlayerIndex -= 1;
        personVectors.pop();
        favoriteGamePicks.pop();
        leastFavoriteGamePicks.pop();
        renderPersonalityQuiz();
    } else {
        showSection(playerSection);
    }
});
startOverBtn.addEventListener('click', resetToPlayerStep);

loadGames();
loadTipi();
