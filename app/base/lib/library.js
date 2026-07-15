// Pure record-library helpers — no React, no DOM, no platform deps.

// Plain (unsynced) lyrics carry no timestamps — time:null marks them so the
// player renders the flat auto-scroll view instead of pretending to be synced.
export const plainToLines = txt => (txt || "").split("\n").filter(l => l.trim()).map(text => ({ time: null, text }));

// Given names commonly seen on record sleeves — used to tell solo artists
// ("David Bowie" → file under Bowie) from bands ("Fleetwood Mac" → file
// under Fleetwood). Lowercase, ASCII-folded before lookup.
const GIVEN_NAMES = new Set(("aaron adam al alan albert alex alice amy andre andrew andy angus anita ann anna anne annie anthony aretha ariana art arthur barbara barry ben bernie bessie beth betty bill billie billy blake bob bobby bonnie brad brandi brian britney bruce bruno bryan buddy burt carl carlos carly carole caroline carrie cat celine charles charley charlie chet chris christina christopher chuck claude cliff conor craig curtis cyndi dan daniel danny darius dave david dean debbie demi dennis diana dinah dolly don donald donna doris doug duke dusty dwight earl ed eddie edgar edith edward ella ellie elton elvis emily emma emmylou eric erykah etta ezra fats fiona frank frankie fred freddie gary gene george gil gladys glen glenn gloria gordon grace graham gram gregg gwen hank hannah harry heather helen henry herb herbie howard hugh ian iggy irma isaac jack jackie jacob james jamie jan jane janet janis jason jay jeff jennifer jenny jerry jesse jessica jim jimi jimmie jimmy joan joe joey john johnny joni jose joseph josh juan judy julia julian julie justin kacey kanye karen kate katy keith kelly ken kendrick kenny kevin kim kris kurt kylie lana larry laura lauryn lee lena lenny leon leonard liam linda lionel lisa lloyd lou louis lucinda luke lyle maggie marc margo maria mariah marie mark martha martin marvin mary matt matthew mavis max mel melissa michael mick mike miles muddy nancy nat natalie neil nick nicki nina norah oliver olivia oscar otis patsy patti paul paula peggy percy pete peter phil philip phoebe quincy randy ray reba rebecca richard rick ricky rita rob robert roberta robin rod roger ron ronnie rory rosanne roy ruth ryan sam samuel sara sarah scott sean selena shania sharon shawn sheryl sonny stan stephen steve steven stevie sufjan susan suzanne syd taylor ted terry thelonious thom thomas tim tina tom tommy toni tony tracy travis vince walter warren wayne wes willie woody yoko yusuf").split(" "));

// Interior tokens that mark a group name rather than a person.
const BAND_SIGNALS = /[&+,]|\b(and|the|of|in|with|feat|featuring|vs)\b/i;

const fold = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// Record-shop filing key: solo artists file under their surname ("David
// Bowie" → "bowie david"), bands under their name minus a leading "The "
// ("The Rolling Stones" → "rolling stones"). "X & the Y" names file under
// the leader ("Tom Petty and the Heartbreakers" → "petty tom").
export function artistSortKey(name) {
  const clean = (name || "").trim().replace(/^the\s+/i, "");
  if (!clean) return "";
  const leader = clean.match(/^(.+?)\s*(?:&|\+|and)\s+(?:the|his|her)\s+/i);
  if (leader) return artistSortKey(leader[1]);
  const words = clean.split(/\s+/);
  const isPerson = words.length > 1 && words.length <= 3 && !BAND_SIGNALS.test(clean) &&
    (GIVEN_NAMES.has(fold(words[0]).replace(/[^a-z]/g, "")) || /^([a-z]\.)+$/i.test(words[0]));
  return fold(isPerson ? `${words[words.length - 1]} ${words.slice(0, -1).join(" ")}` : clean);
}

const cmp = (a, b) => (a || "").localeCompare(b || "", undefined, { sensitivity: "base" });

// Order a record library: the (up to 2) most-recently-played albums first, in
// recency order, then everything else filed record-shop style by artist sort
// key (ties broken by full artist name, then album name).
export function orderLibrary(lib, recentIds) {
  const seen = new Set();
  const recent = [];
  for (const id of (recentIds || [])) {
    const a = (lib || []).find(x => String(x.itunes_collection_id) === String(id));
    if (a && !seen.has(String(id))) { recent.push(a); seen.add(String(id)); }
  }
  const rest = (lib || [])
    .filter(x => !seen.has(String(x.itunes_collection_id)))
    .sort((a, b) =>
      cmp(artistSortKey(a.artist_name), artistSortKey(b.artist_name)) ||
      cmp(a.artist_name, b.artist_name) ||
      cmp(a.album_name, b.album_name));
  return [...recent, ...rest];
}
