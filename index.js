#!/usr/bin/env node

const { Command } = require('commander');
const os = require('os');
const chalk = require('chalk');
const ora = require('ora');
const { existsSync } = require('fs');
const { join, normalize, resolve, dirname } = require('path');
const debug = require('debug')('cnki_crawler');
const { access, stat } = require('fs/promises');
const xlsx = require('xlsx');
const puppeteer = require('puppeteer-core');
const { version = '0.0.1' } = require('./package.json');
const { assert } = require('console');

// construct the argv parser
const program = new Command();
program.version(version);
program
  .option('-d, --debug', 'output extra debugging')
  .option('-l, --headless', 'output extra debugging')
  .option('-i, --input <xlsx_file_path>', 'input xlsx data file', 'input.xlsx')
  .option('-o, --output <xlsx_file_path>', 'output xlsx data file', 'output.xlsx');

program.parse(process.argv);

const { debug: verbose, headless, input, output } = program.opts();

function getChromePath() {
  let browserPath;

  if (os.type() === 'Windows_NT') {
    // Chrome is usually installed as a 32-bit application, on 64-bit systems it will have a different installation path.
    const programFiles = os.arch() === 'x64' ? process.env['PROGRAMFILES(X86)'] : process.env.PROGRAMFILES;
    browserPath = join(programFiles, 'Google/Chrome/Application/chrome.exe');
  } else if (os.type() === 'Linux') {
    browserPath = '/usr/bin/google-chrome';
  } else if (os.type() === 'Darwin') {
    browserPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  if (browserPath && browserPath.length > 0) {
    return normalize(browserPath);
  }

  throw new TypeError(`Cannot run action. ${os.type} is not supported.`);
}

async function oraProcess(title, cb) {
  const spinner = ora({ text: `${title} starting...`, isEnabled: true }).start();
  try {
    await cb();
    spinner.succeed(`${title} finished...`);
    return true;
  } catch (error) {
    spinner.fail(`${title} failed...`);
    return false;
  }
}

async function completeInfo(inputData) {
  let spinner = ora({ text: 'Processing...', isEnabled: true }).stopAndPersist();
  const browser = await puppeteer.launch({
    headless: headless || false,
    executablePath: getChromePath(),
  });
  let [page] = await browser.pages();
  // auto fit the viewport, see https://stackoverflow.com/questions/52553311/how-to-set-max-viewport-in-puppeteer
  page.setViewport({ width: 0, height: 0 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    request.continue();
  });
  page.on('error', (err) => {
    console.log('\nError occurred: ', err);
  });
  page.on('pageerror', (pageerr) => {
    console.log('\nPageerror occurred: ', pageerr);
  });
  const results = [];
  const recordCount = inputData.length;
  for (let i = 0; i < recordCount; i++) {
    const record = inputData[i];
    spinner = ora({
      text: `[${i + 1}/${recordCount}] Processing ${record.title} using cnki`,
      isEnabled: true,
    }).start();
    try {
      // open www.cnki.net
      await page.goto(`https://www.cnki.net/`, {
        waitUntil: 'networkidle0',
      });
      // execute window.name='highsearch' in order not open a new tab when click advanced search!
      await page.evaluate(() => {
        window.name = 'highsearch';
        console.info(`window.name: ${window.name}`);
      });
      // navigate to advanced search page
      const advancedSearchSelector = `a#highSearch`;
      // await page.$eval(advancedSearchSelector, el => el.setAttribute("target", "_self"));
      await page.click(advancedSearchSelector);
      // wait some time for window.open finish
      await page.waitForTimeout(500);
      // // NEED to switch to the new opened tab
      // let pages = await browser.pages();
      // if (pages.length < 2) {
      //   console.info(chalk.yellow.bold(`PLEASE increase the wait timeout above!`));
      //   process.exit(-1);
      // }
      // assert(pages.length === 2, `Currently have and only have two tabs opened!`);
      // page = pages[1]
      // pages[0].close()
      // input title, source for searching
      await page.waitForSelector(`input[data-tipid="gradetxt-1"]`);
      await page.type(`input[data-tipid="gradetxt-1"]`, record.title, { delay: 50 });
      await page.type(`input[data-tipid="gradetxt-3"]`, record.source, { delay: 50 });
      // click the search button
      const searchSelector = `input[class="btn-search"]`;
      await page.$eval(searchSelector, (el) => el.setAttribute('target', '_self'));
      await page.click(searchSelector);

      // get the detailed link from the first row
      const firstRowTitleLinkSelector = '#gridTable > table > tbody > tr > td.name > a';
      await page.waitForSelector(firstRowTitleLinkSelector);
      const firstRowTitleLink = await page.$(firstRowTitleLinkSelector);
      if (verbose) {
        spinner.text = chalk.blue.bold(`firstRowTitleLink: `, firstRowTitleLink);
      }
      // navigate to the detailed page
      await page.$eval(firstRowTitleLinkSelector, (el) => el.setAttribute('target', '_self'));
      // sometime the following click did not work!!!
      // await page.click(firstRowTitleLinkSelector);
      // await firstRowTitleLink.click();
      await page.evaluate(() => {
        const ele = document.querySelector('#gridTable > table > tbody > tr > td.name > a');
        console.info(ele);
        ele.click();
      });
      // wait some time for navigation finish
      await page.waitForTimeout(100);

      // get the metadata info
      const authorSpanSelector = '#authorpart > span';
      await page.waitForSelector(authorSpanSelector);
      if (verbose) {
        const authorSpan = await page.$(authorSpanSelector);
        spinner.text = chalk.blue.bold(`authorSpan: `, authorSpan);
      }
      const authorsText = await page.$$eval(authorSpanSelector, (els) =>
        els.map((el) => el.innerText.replace(/\d/, '')),
      );
      const releaseDateText = await page.$eval(
        'div.top-first > div.top-tip > span > a:nth-child(2)',
        (el) => el.innerText,
      );
      record.authors = authorsText.join(',');
      record.author_count = authorsText.length;
      record.release_date = releaseDateText;
      spinner.succeed(`[${i + 1}/${recordCount}] Processed ${record.title}, result: ${JSON.stringify(record)}`);
      results.push(record);
    } catch (error) {
      console.error(error);
      results.push(record);
      continue;
    }
  }
  await browser.close();
  return results;
}

(async () => {
  // check the argv
  if (!(await existsSync(input))) {
    debug(`input: ${input} does not exists!`);
    process.exit(-1);
  }
  if (await existsSync(output)) {
    console.warn(chalk.yellow.bold(`output: ${output} exists already, will overwrite!`));
  }
  try {
    // parse xlsx input
    const workbook = xlsx.readFile(input);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    if (verbose) {
      console.info(chalk.blue.bold(`try to parse xlsx file: ${input}`));
    }
    const inputData = xlsx.utils.sheet_to_json(worksheet, { raw: true });
    if (verbose) {
      console.info(chalk.blue.bold(`got parsed input data: ${JSON.stringify(inputData, null, 2)}`));
    }
    // do the crawler job
    const results = await completeInfo(inputData);
    // output the result
    if (verbose) {
      console.info(chalk.blue.bold(`try to write xlsx result file: ${JSON.stringify(results, null, 2)}`));
    }
    const ws = xlsx.utils.json_to_sheet(results);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws);
    xlsx.writeFile(wb, output);
  } catch (error) {
    console.error(error);
  }
})();
