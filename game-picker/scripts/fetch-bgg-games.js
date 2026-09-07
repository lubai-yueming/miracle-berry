#!/usr/bin/env node
/**
 * Batch-ingest the top-N BGG-ranked games into game-picker/games.json.
 *
 * This is the "round 2" ingestion tool described in the design doc
 * (.cursor/plans/individual_multi-player_game_matching_e3b4a1f6.plan.md,
 * "Inventory expansion, round 2: scaling to the top ~10,000 ranked games").
 * It keeps the app's static-file architecture unchanged - this script just
 * regenerates games.json; nothing in app.js/index.html needs to change.
 *
 * WHAT YOU NEED BEFORE RUNNING THIS:
 *   1. A BGG API bearer token (from an approved application at
 *      boardgamegeek.com/applications). Provide it via, in priority order:
 *        --token <value>
 *        BGG_API_TOKEN environment variable
 *        a local file at game-picker/scripts/.bgg-token (gitignored)
 *   2. A seed CSV/TSV of ranked games (id + name + rank + rating columns -
 *      same shape as the top-1000 export already used once in this repo).
 *      Pass its path via --seed.
 *
 * USAGE:
 *   node fetch-bgg-games.js --seed ./bgg-top10k.csv [options]
 *
 * OPTIONS:
 *   --seed <path>          Required. Path to the seed CSV/TSV of ranked games.
 *   --out <path>           Output games.json path. Default: ../games.json
 *   --limit <n>            Max number of ranked games to ingest. Default: 10000
 *   --batch-size <n>       BGG thing ids per request. Default: 20 (this is a
 *                          hard server-side cap - confirmed empirically:
 *                          requesting more returns HTTP 400 "Cannot load
 *                          more than 20 items". The 250-500/batch figure in
 *                          earlier community write-ups does not hold for the
 *                          current authenticated thing?stats=1 endpoint.)
 *   --cooldown-ms <n>      Delay between batches, in ms. Default: 2000
 *   --token <value>        BGG API bearer token (overrides env/file).
 *   --dry-run              Fetch + parse + report, but don't write games.json.
 *   --include-expansions   Don't skip rows where is_expansion=1 in the seed file.
 *   --max-description-length <n>  Truncate descriptions to this many chars
 *                          (first paragraph, then word-boundary cut). Default:
 *                          300. BGG's raw descriptions run 1,300 chars on
 *                          average (some 8,000+) and dominate file size
 *                          (84% of a real 3k-game run). Pass 0 to disable
 *                          truncation and keep full descriptions.
 *
 * WHY THIS IS SAFE TO RUN REPEATEDLY:
 *   Existing games.json entries are matched by bgg_id and updated in place
 *   (upsert), not duplicated. New games get a fresh sequential internal "id".
 *   Nothing here overwrites the internal "id" field of an existing entry.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = {
        seed: null,
        out: path.join(__dirname, '..', 'games.json'),
        limit: 10000,
        batchSize: 20,
        cooldownMs: 2000,
        token: null,
        dryRun: false,
        includeExpansions: false,
        maxDescriptionLength: 300,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case '--seed': args.seed = next(); break;
            case '--out': args.out = path.resolve(next()); break;
            case '--limit': args.limit = parseInt(next(), 10); break;
            case '--batch-size': args.batchSize = parseInt(next(), 10); break;
            case '--cooldown-ms': args.cooldownMs = parseInt(next(), 10); break;
            case '--token': args.token = next(); break;
            case '--dry-run': args.dryRun = true; break;
            case '--include-expansions': args.includeExpansions = true; break;
            case '--max-description-length': args.maxDescriptionLength = parseInt(next(), 10); break;
            default:
                console.error(`Unknown argument: ${arg}`);
                process.exit(1);
        }
    }
    if (!args.seed) {
        console.error('Missing required --seed <path-to-csv>. See file header for usage.');
        process.exit(1);
    }
    return args;
}

// ---------------------------------------------------------------------------
// Token resolution: --token > BGG_API_TOKEN env var > .bgg-token file
// ---------------------------------------------------------------------------

function loadToken(cliToken) {
    if (cliToken) return cliToken.trim();
    if (process.env.BGG_API_TOKEN) return process.env.BGG_API_TOKEN.trim();
    const tokenFile = path.join(__dirname, '.bgg-token');
    if (fs.existsSync(tokenFile)) {
        return fs.readFileSync(tokenFile, 'utf8').trim();
    }
    console.error(
        'No BGG API token found. Provide one via --token, the BGG_API_TOKEN\n' +
        'environment variable, or a game-picker/scripts/.bgg-token file (gitignored).'
    );
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Seed CSV/TSV parsing
//
// Tolerant of the exact format pasted once before in this project (tab-
// delimited: id, name, yearpublished, rank, bayesaverage, average,
// usersrated, is_expansion, plus per-subdomain rank columns), but only
// requires id/name/rank + a rating column (bayesaverage, falling back to
// average) to actually be present - everything else is ignored.
// ---------------------------------------------------------------------------

function detectDelimiter(headerLine) {
    return headerLine.includes('\t') ? '\t' : ',';
}

/**
 * RFC-4180-ish delimited line parser: handles quoted fields (including a
 * delimiter or escaped "" inside quotes). Needed because real BGG rank
 * exports are comma-delimited CSVs where game names routinely contain
 * commas (e.g. "Dagger Thrusts: Patton & Montgomery, 1944") - a naive
 * line.split(delimiter) silently shifts every column after such a field.
 * Does not handle a quoted field containing a literal newline.
 */
function parseDelimitedLine(line, delimiter) {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') {
                    current += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                current += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === delimiter) {
            cells.push(current);
            current = '';
        } else {
            current += c;
        }
    }
    cells.push(current);
    return cells;
}

function parseSeedFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) {
        console.error(`Seed file ${filePath} has no data rows.`);
        process.exit(1);
    }
    const delimiter = detectDelimiter(lines[0]);
    const header = parseDelimitedLine(lines[0], delimiter).map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name);

    const idCol = col('id');
    const nameCol = col('name');
    const rankCol = col('rank');
    const bayesCol = col('bayesaverage');
    const avgCol = col('average');
    const expansionCol = col('is_expansion');

    if (idCol === -1 || rankCol === -1) {
        console.error(
            `Seed file ${filePath} is missing required "id"/"rank" columns.\n` +
            `Found header: ${header.join(', ')}`
        );
        process.exit(1);
    }

    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
        const cells = parseDelimitedLine(lines[i], delimiter);
        const bggId = parseInt(cells[idCol], 10);
        const rank = parseInt(cells[rankCol], 10);
        if (!bggId || !rank) continue; // unranked or malformed row - out of scope
        const ratingRaw = bayesCol !== -1 ? cells[bayesCol] : (avgCol !== -1 ? cells[avgCol] : null);
        const rating = ratingRaw != null ? parseFloat(ratingRaw) : null;
        const isExpansion = expansionCol !== -1 && cells[expansionCol].trim() === '1';
        rows.push({
            bgg_id: bggId,
            name: nameCol !== -1 ? cells[nameCol].trim() : null,
            bgg_rank: rank,
            bgg_rating: Number.isFinite(rating) ? rating : null,
            is_expansion: isExpansion,
        });
    }
    return rows;
}

// ---------------------------------------------------------------------------
// BGG family-rank ("subdomain") / category / mechanic -> existing genre vocabulary
//
// Heuristic, not a validated mapping (same caveat as OCEAN_WEIGHTS in
// app.js). All entries below were checked against real thing?stats=1
// responses for a diverse sample of games (Pandemic, Coup, Codenames, Camel
// Up, Puerto Rico, 7 Wonders, Dixit, Catan, El Grande, Ark Nova) rather than
// assumed from memory - BGG's actual tag vocabulary has some non-obvious
// spelling/spacing (e.g. "Betting and Bluffing", not "Bluffing", is the
// mechanic name; "Auction / Bidding" has spaces around the slash).
//
// Important: what's commonly called a game's "subdomain" (Strategy Games,
// Family Games, etc.) is NOT exposed as a <link type="boardgamesubdomain">
// in the current API - it only appears as <rank type="family" name="..."/>
// inside the statistics/ratings/ranks block (see extractFamilyRankNames).
// The name values there (e.g. "strategygames") match the seed CSV's own
// per-subdomain rank column names (strategygames_rank, familygames_rank, etc).
//
// Unmapped BGG tags are silently dropped - computeGameVector in app.js
// already treats a missing genre tag as a safe zero contribution. Revisit
// this table as more real data flows in (per the bgg-genre-mapping-table todo).
// ---------------------------------------------------------------------------

const BGG_TAG_TO_GENRE = {
    // family-rank name (from <rank type="family" name="...">) - most reliable signal
    strategygames: ['strategy'],
    familygames: ['family'],
    partygames: ['party'],
    childrensgames: ['family'],
    cgs: ['card'], // "Customizable Games" (CCGs/LCGs)
    thematic: ['adventure'],
    abstracts: ['puzzle'],
    // 'wargames': no existing genre tag maps cleanly - intentionally unmapped

    // boardgamecategory
    'Card Game': ['card'],
    'Economic': ['economy-building'],
    'Puzzle': ['puzzle'],
    'Party Game': ['party'],
    'Bluffing': ['bluffing'],
    'Deduction': ['deduction'],
    'Adventure': ['adventure'],
    'Exploration': ['adventure'],
    'Civilization': ['civilization'],
    'Racing': ['racing'],
    'Dice': ['dice'],
    'Word Game': ['word'],
    "Children's Game": ['family'],

    // boardgamemechanic
    'Cooperative Game': ['cooperative'],
    'Dice Rolling': ['dice'],
    'Betting and Bluffing': ['bluffing'],
    'Hidden Roles': ['bluffing'],
    'Worker Placement': ['strategy', 'economy-building'],
    'Action Drafting': ['strategy'],
    'Closed Drafting': ['strategy'],
    'Tile Placement': ['strategy'],
    'Area Majority / Influence': ['strategy'],
    'Network and Route Building': ['strategy'],
    'Auction / Bidding': ['economy-building'],
    'Storytelling': ['party'],
};

function mapBggTagsToGenres(tags) {
    const genres = new Set();
    tags.forEach((tag) => {
        const mapped = BGG_TAG_TO_GENRE[tag];
        if (mapped) mapped.forEach((g) => genres.add(g));
    });
    return [...genres].sort();
}

// ---------------------------------------------------------------------------
// Minimal, purpose-built XML extraction (BGG's thing?stats=1 response shape).
// Deliberately regex-based instead of pulling in an XML dependency, since
// this is a static-site repo with no existing package.json/node_modules.
// ---------------------------------------------------------------------------

function splitItems(xml) {
    const items = [];
    const re = /<item\b[^>]*>[\s\S]*?<\/item>/g;
    let match;
    while ((match = re.exec(xml)) !== null) {
        items.push(match[0]);
    }
    return items;
}

function extractItemAttr(itemXml, attr) {
    const re = new RegExp(`<item\\b[^>]*\\b${attr}="([^"]*)"`);
    const match = itemXml.match(re);
    return match ? match[1] : null;
}

function extractTagValue(itemXml, tag) {
    const re = new RegExp(`<${tag}\\b[^>]*\\bvalue="([^"]*)"`);
    const match = itemXml.match(re);
    return match ? match[1] : null;
}

function decodeXmlEntities(str) {
    return str
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#10;/g, '\n')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
        .trim();
}

function extractPrimaryName(itemXml) {
    const re = /<name\b[^>]*\btype="primary"[^>]*\bvalue="([^"]*)"/;
    const match = itemXml.match(re);
    return match ? decodeXmlEntities(match[1]) : null;
}

function extractDescription(itemXml) {
    const match = itemXml.match(/<description>([\s\S]*?)<\/description>/);
    return match ? decodeXmlEntities(match[1]) : '';
}

/**
 * BGG's raw descriptions run ~1,300 chars on average (some 8,000+, covering
 * full rules/expansion history) and dominate games.json's file size (84% of
 * it in a real 3k-game run). Takes just the first paragraph, then hard-caps
 * at maxLen on a word boundary. maxLen <= 0 disables truncation entirely.
 */
function truncateDescription(description, maxLen) {
    if (!description || !maxLen || maxLen <= 0) return description;
    const firstParagraph = description.split(/\n\s*\n/)[0].trim();
    if (firstParagraph.length <= maxLen) return firstParagraph;
    const cut = firstParagraph.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

function extractAverageWeight(itemXml) {
    const match = itemXml.match(/<averageweight\b[^>]*\bvalue="([^"]*)"/);
    return match ? parseFloat(match[1]) : null;
}

function extractLinks(itemXml, linkType) {
    const values = [];
    const re = new RegExp(`<link\\b[^>]*\\btype="${linkType}"[^>]*\\bvalue="([^"]*)"`, 'g');
    let match;
    while ((match = re.exec(itemXml)) !== null) {
        values.push(decodeXmlEntities(match[1]));
    }
    return values;
}

/**
 * A game's "subdomain" (Strategy Games, Family Games, Party Games, etc.) is
 * not a <link> in BGG's current thing?stats=1 response - it only shows up as
 * a per-subdomain rank inside statistics/ratings/ranks, e.g.:
 *   <rank type="family" id="5497" name="strategygames" friendlyname="Strategy Game Rank" .../>
 * A game only gets a rank in a subdomain it belongs to (and has enough
 * ratings for), so the presence of one of these is a reliable, if partial,
 * signal - it can under-report for very obscure games, but won't over-report.
 * The \b before `name=` is required so this doesn't also match `friendlyname="..."`.
 */
function extractFamilyRankNames(itemXml) {
    const values = [];
    const re = /<rank\b[^>]*\btype="family"[^>]*\bname="([^"]*)"/g;
    let match;
    while ((match = re.exec(itemXml)) !== null) {
        values.push(match[1]);
    }
    return values;
}

/**
 * BGG's "suggested_numplayers" poll looks like:
 *   <poll name="suggested_numplayers" ...>
 *     <results numplayers="1">
 *       <result value="Best" numvotes="12"/>
 *       <result value="Recommended" numvotes="30"/>
 *       <result value="Not Recommended" numvotes="5"/>
 *     </results>
 *     ...
 *   </poll>
 * ideal_players = every numplayers bucket whose "Best" votes are within 70%
 * of the single highest "Best" vote count (captures a sweet-spot range like
 * [3, 4] rather than only ever a single number), skipped entirely if the
 * poll has too few total votes to be meaningful.
 */
function extractIdealPlayers(itemXml) {
    const pollMatch = itemXml.match(/<poll\b[^>]*\bname="suggested_numplayers"[^>]*>([\s\S]*?)<\/poll>/);
    if (!pollMatch) return [];
    const pollXml = pollMatch[1];
    const totalVotesMatch = itemXml.match(/<poll\b[^>]*\bname="suggested_numplayers"[^>]*\btotalvotes="([^"]*)"/);
    const totalVotes = totalVotesMatch ? parseInt(totalVotesMatch[1], 10) : 0;
    if (!totalVotes || totalVotes < 10) return []; // too few votes to trust

    const buckets = [];
    const resultsRe = /<results\b[^>]*\bnumplayers="([^"]*)"[^>]*>([\s\S]*?)<\/results>/g;
    let match;
    while ((match = resultsRe.exec(pollXml)) !== null) {
        const numplayers = parseInt(match[1], 10);
        if (!numplayers) continue; // skips the "4+" style open-ended bucket
        const bestMatch = match[2].match(/<result\b[^>]*\bvalue="Best"[^>]*\bnumvotes="([^"]*)"/);
        const bestVotes = bestMatch ? parseInt(bestMatch[1], 10) : 0;
        buckets.push({ numplayers, bestVotes });
    }
    if (buckets.length === 0) return [];
    const maxBest = Math.max(...buckets.map((b) => b.bestVotes));
    if (maxBest === 0) return [];
    return buckets
        .filter((b) => b.bestVotes >= maxBest * 0.7)
        .map((b) => b.numplayers)
        .sort((a, b) => a - b);
}

function parseGameFromItem(itemXml, options = {}) {
    const maxDescriptionLength = options.maxDescriptionLength != null ? options.maxDescriptionLength : 300;
    const bggId = parseInt(extractItemAttr(itemXml, 'id'), 10);
    const name = extractPrimaryName(itemXml);
    const minPlayers = parseInt(extractTagValue(itemXml, 'minplayers'), 10) || null;
    const maxPlayers = parseInt(extractTagValue(itemXml, 'maxplayers'), 10) || null;
    const playingTime = parseInt(extractTagValue(itemXml, 'playingtime'), 10) || null;
    const weight = extractAverageWeight(itemXml);
    const description = truncateDescription(extractDescription(itemXml), maxDescriptionLength);

    const familyRanks = extractFamilyRankNames(itemXml);
    const categories = extractLinks(itemXml, 'boardgamecategory');
    const mechanics = extractLinks(itemXml, 'boardgamemechanic');
    const genres = mapBggTagsToGenres([...familyRanks, ...categories, ...mechanics]);

    const idealPlayers = extractIdealPlayers(itemXml);

    return {
        bgg_id: bggId,
        name,
        min_players: minPlayers,
        max_players: maxPlayers,
        min_avg_length_minutes: playingTime,
        weight: Number.isFinite(weight) ? Math.round(weight * 100) / 100 : null,
        ideal_players: idealPlayers,
        genres,
        description,
    };
}

// ---------------------------------------------------------------------------
// Batched fetching against BGG's thing?stats=1 endpoint
// ---------------------------------------------------------------------------

function chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBatch(ids, token, attempt = 1) {
    const url = `https://boardgamegeek.com/xmlapi2/thing?id=${ids.join(',')}&stats=1`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'miracle-berry-game-picker-ingestion/1.0',
        },
    });

    if (response.status === 429 || response.status >= 500) {
        if (attempt > 4) {
            throw new Error(`Giving up on batch after ${attempt} attempts (status ${response.status})`);
        }
        const backoffMs = 5000 * 2 ** (attempt - 1);
        console.error(`  batch got status ${response.status}, retrying in ${backoffMs}ms (attempt ${attempt})`);
        await sleep(backoffMs);
        return fetchBatch(ids, token, attempt + 1);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        const hint = response.status === 400 && /more than \d+ items/i.test(body)
            ? ' (try a smaller --batch-size - BGG caps ids per request)'
            : '';
        throw new Error(`BGG request failed: HTTP ${response.status} for ids ${ids.join(',')}${hint}: ${body}`);
    }

    return response.text();
}

// ---------------------------------------------------------------------------
// Upsert into games.json
// ---------------------------------------------------------------------------

function loadExistingGames(outPath) {
    if (!fs.existsSync(outPath)) return [];
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

function upsertGame(existingGames, fetched, seedMeta) {
    const merged = {
        min_players: fetched.min_players,
        max_players: fetched.max_players,
        min_avg_length_minutes: fetched.min_avg_length_minutes,
        weight: fetched.weight,
        ideal_players: fetched.ideal_players.length > 0 ? fetched.ideal_players : undefined,
        genres: fetched.genres,
        description: fetched.description,
        bgg_id: fetched.bgg_id,
        bgg_rank: seedMeta.bgg_rank,
        bgg_rating: seedMeta.bgg_rating,
    };

    const existingIndex = existingGames.findIndex((g) => g.bgg_id === fetched.bgg_id);
    if (existingIndex !== -1) {
        const existing = existingGames[existingIndex];
        existingGames[existingIndex] = {
            ...existing,
            name: fetched.name || existing.name,
            ...merged,
            ideal_players: merged.ideal_players || existing.ideal_players,
        };
        return 'updated';
    }

    const nextId = String(
        Math.max(0, ...existingGames.map((g) => parseInt(g.id, 10) || 0)) + 1
    );
    existingGames.push({
        id: nextId,
        name: fetched.name,
        ...merged,
        ideal_players: merged.ideal_players || [],
    });
    return 'inserted';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const token = loadToken(args.token);

    console.log(`Reading seed file: ${args.seed}`);
    let seedRows = parseSeedFile(args.seed);
    if (!args.includeExpansions) {
        seedRows = seedRows.filter((r) => !r.is_expansion);
    }
    seedRows.sort((a, b) => a.bgg_rank - b.bgg_rank);
    seedRows = seedRows.slice(0, args.limit);
    console.log(`Ingesting ${seedRows.length} ranked games (limit ${args.limit}).`);

    const seedByBggId = new Map(seedRows.map((r) => [r.bgg_id, r]));
    const batches = chunk(seedRows.map((r) => r.bgg_id), args.batchSize);
    console.log(`${batches.length} batches of up to ${args.batchSize} ids, ${args.cooldownMs}ms cooldown between batches.`);

    const existingGames = loadExistingGames(args.out);
    let updatedCount = 0;
    let insertedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < batches.length; i += 1) {
        const batchIds = batches[i];
        console.log(`Batch ${i + 1}/${batches.length} (${batchIds.length} ids)...`);
        const xml = await fetchBatch(batchIds, token);
        const items = splitItems(xml);

        items.forEach((itemXml) => {
            const fetched = parseGameFromItem(itemXml, { maxDescriptionLength: args.maxDescriptionLength });
            const seedMeta = seedByBggId.get(fetched.bgg_id);
            const hasMinimumSignal = fetched.name && fetched.min_players && fetched.max_players
                && fetched.min_avg_length_minutes && Number.isFinite(fetched.weight);
            if (!hasMinimumSignal || !seedMeta) {
                skippedCount += 1;
                console.error(`  skipping bgg_id=${fetched.bgg_id} (${fetched.name || 'unknown'}) - missing required fields`);
                return;
            }
            const result = upsertGame(existingGames, fetched, seedMeta);
            if (result === 'updated') updatedCount += 1;
            else insertedCount += 1;
        });

        if (i < batches.length - 1) {
            await sleep(args.cooldownMs);
        }
    }

    console.log(`\nDone. Updated: ${updatedCount}, inserted: ${insertedCount}, skipped: ${skippedCount}.`);
    console.log(`Total games in output: ${existingGames.length}.`);

    if (args.dryRun) {
        console.log('(--dry-run set: not writing output file)');
        return;
    }

    fs.writeFileSync(args.out, JSON.stringify(existingGames, null, 4) + '\n');
    console.log(`Wrote ${args.out}`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Ingestion failed:', err);
        process.exit(1);
    });
}

module.exports = {
    parseSeedFile,
    mapBggTagsToGenres,
    splitItems,
    extractFamilyRankNames,
    extractIdealPlayers,
    truncateDescription,
    parseGameFromItem,
    upsertGame,
};
