const fetch = require("node-fetch");
const wdk = require("wikidata-sdk");
const wtf = require("wtf_wikipedia");

const searchLimit = 500;
const url = `https://en.wiktionary.org/w/api.php?action=query&list=categorymembers&cmtitle=Category%3AEnglish_verbs&cmlimit=${searchLimit}&format=json`;
const irregs = ["ceebs", "cleave", "frain", "giue", "resing", "shend", "shew", "shrive", "talebear", "toshend", "toshake", "toshear", "thas", "thass", "XQs"];

function getDocInfo(doc) {
  let invalidStems = ["d", "ed", "es", "ing", "s"];
  let templates = doc.templates("en-verb");
  if (templates.length !== 1) return {error: "multiple or no en-verb templates"};
  const t = templates[0];
  const verb = doc.options.title;
  
  // start with auto-infered data, then change it if needed
  let data = {
    present: verb,
    thirdPersonSingular: `${verb}s`,
    simplePast: `${verb}ed`,
    presentParticiple: `${verb}ing`,
    pastParticiple: `${verb}ed`,
  };
  
  if (t.list) {
    // possiblities:
    // 1. legacy syntax
    // 2. specifing all forms
    // 3. {{en-verb|d}}
    // 4. {{en-verb|differennt-stem|d}}
    if (t.list[0] === verb && t.list.length > 3) {
      console.warn(verb, "is legacy");
      return {error: "Legacy syntax"};
    }
    
    if (t.list.length === 3 && invalidStems.includes(t.list[2])) {
      /*
        {{en-verb|bus|s|es}} (added an s)
        {{en-verb|cr|i|ed}} (changed the -y to -i)
        {{en-verb|t|y|ing}} (changed the -ie to -y)
        {{en-verb|trek|k|ed}} (added a k)
      */
      let ending = t.list[2];
      let formToChange = ({
        d: "all-past",
        ed: "all-past",
        ing: "presentParticiple",
        es: "thirdPersonSingular",
        s: "thirdPersonSingular",
      })[ending];
      if (!formToChange) return {error: "Invalid formToChange"};
      if (formToChange === "all-past") {
        data.simplePast = `${t.list[0]}${t.list[1]}${ending}`;
        data.pastParticiple = `${t.list[0]}${t.list[1]}${ending}`;
        data.presentParticiple = `${t.list[0]}${t.list[1]}ing`;
        data.thirdPersonSingular = `${verb}s`;
      } else if (formToChange === "presentParticiple") {
        data.presentParticiple = `${t.list[0]}${t.list[1]}${ending}`;
        // data.simplePast = `${t.list[0]}${t.list[1]}d`;
        data.pastParticiple = `${verb}d`;
        data.simplePast = `${verb}d`;
      } else if (formToChange === "thirdPersonSingular") {
        data.thirdPersonSingular = `${t.list[0]}${t.list[1]}${ending}`;
        data.simplePast = `${t.list[0]}${t.list[1]}ed`;
        data.pastParticiple = `${t.list[0]}${t.list[1]}ed`;
        data.presentParticiple = `${t.list[0]}${t.list[1]}ing`;
      }
    } else if ((t.list.length === 3) && !invalidStems.includes(t.list[2])) {
      data.thirdPersonSingular = t.list[0];
      data.presentParticiple = t.list[1];
      data.simplePast = t.list[2];
      data.pastParticiple = t.list[2];
    } else if (t.list.length === 4) {
      data.thirdPersonSingular = t.list[0];
      data.presentParticiple = t.list[1];
      data.simplePast = t.list[2];
      data.pastParticiple = t.list[3];
    } else {
      let stem = verb;
      let list = t.list;
      if (!invalidStems.includes(t.list[0])) {
        stem = t.list[0];
        list.shift();
      }
     
      data = {
        ...data,
        //present: stem,
        //thirdPersonSingular: `${stem}s`,
        simplePast: `${stem}ed`,
        presentParticiple: `${stem}ing`,
        pastParticiple: `${stem}ed`,
      };
      
      if (list[0] === "es") {
        data.thirdPersonSingular = `${stem}es`;
      } else if (list[0] === "d") {
        data.simplePast = `${stem}d`;
        data.pastParticiple = `${stem}d`;
      } else if (list[0] === "ies") {
        data.thirdPersonSingular = `${stem}ies`;
        data.pastParticiple = `${stem}ied`;
        data.simplePast = `${stem}ied`;
        data.presentParticiple = `${verb}ing`;
      } else {
        // just a stem was provided
        // {{en-verb|admir|ing}} is the same as {{en-verb|admir}}
      }
    }
    if (t.pres_3sg) data.thirdPersonSingular = t.pres_3sg;
    if (t.pres_ptc) data.presentParticiple = t.pres_ptc;
    if (t.past) {
      data.simplePast = t.past;
      data.pastParticiple = t.past;
    }
    if (t.past_ptc) data.pastParticiple = t.past_ptc;
  }
  
  return data;
}

async function lexemeExists(search, language = "en") {
  const url = wdk.searchEntities({
    search: search,
    language: language,
    limit: 1,
    format: "json",
    type: "lexeme",
    "continue": 0,
  }) + "&maxlag=5";
  let result;
  try {
    result = await fetch(url, { headers: {"User-Agent": "SixTwoEight's script to determine verbs to be imported to Wikidata"} });
  } catch (e) {
    console.error("e Unable to check if lexeme exists on Wikidata, retrying in 10 seconds.", e);
    await new Promise((resolve, reject) => setTimeout(resolve, 10000));
    return lexemeExists(search, language);
  }
  let text = await result.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { console.error("got bad search JSON", text); process.exit(1); }
  if (!json.search) {
    console.error("no s Unable to check if lexeme exists on Wikidata, retrying in 10 seconds.", json.error.lag);
    console.error(json, url);
    await new Promise((resolve, reject) => setTimeout(resolve, 10000));
    return lexemeExists(search, language);
  }
  return json.search.length !== 0;
}

async function getDictLemmaPage(cmcontinue = "") {
  const res = await fetch(url + (cmcontinue ? ("&cmcontinue=" + cmcontinue) : ""), { headers: {"User-Agent": "SixTwoEight's script to determine verbs to be imported to Wikidata"} });
  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error(await data.text(), "error");
    return await getDictLemmaPage(cmcontinue);
    //throw new Error("bad body");
  }
  if (data.error) {
    console.error("Unable to search Wiktionary, waiting 15 seconds.");
    await new Promise((resolve, reject) => setTimeout(resolve, 15000));
    return await getDictLemmaPage(cmcontinue);
  }
  return data;
}

function invalidVerb(str) {
  //if (str.includes(":")) return true;
  //if (str.includes(" ")) return true;
  if (!str.match(/^[A-Za-z]*$/)) return true;
  if (irregs.includes(str)) return true;
  return false;
}

async function lemmaCheckLoop(cmcontinue = "", total = 0) {
  console.error("lCL");
  var dictData = await getDictLemmaPage(cmcontinue);
  let words = [];
  for (let a = 0; a < dictData.query.categorymembers.length; a++) {
    let lexeme = dictData.query.categorymembers[a];
    if (invalidVerb(lexeme.title)) continue;
    let dataCheck = await lexemeExists(lexeme.title);
    total++;
    if (!dataCheck) {
      const doc = await wtf.fetch(lexeme.title, "enwiktionary", { "Api-User-Agent": "SixTwoEight's script to determine verbs to be imported to Wikidata" });
      const docInfo = getDocInfo(doc);
      if (docInfo.error) {
        console.error("docInfo error", docInfo.error);
        words.push(lexeme.title);
      } else {
        words.push(`~${docInfo.present}~${docInfo.thirdPersonSingular}~${docInfo.simplePast}~${docInfo.presentParticiple}~${docInfo.pastParticiple}`);
      }
      console.error("added", words[words.length - 1]);
    }
  }
  //await new Promise((resolve, reject) => {setTimeout(resolve, searchLimit * 34);});
  //await Promise.all(promises);
  console.error("checked group");
  for (var i = 0; i < words.length; i++) {
    //if (invalidVerb(words[i].title)) continue;
    console.log(words[i]);
    //console.error(words[i].title);
  }
  if (total > 3) {
    console.error("total reached");
    //return;
  }
  if (!dictData.continue || !dictData.continue.cmcontinue) {
    console.error("no continue");
    return;
  }
  return lemmaCheckLoop(dictData.continue.cmcontinue, total);
}

lemmaCheckLoop();
