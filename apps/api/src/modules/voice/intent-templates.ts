import type { InputVoucherStatus } from '../../database/repositories/input-vouchers.repository.js';
import {
  normalizeVoiceIntentLocale,
  speakDate,
  speakMoneyKobo,
  type VoiceIntentLocale
} from './intent-router.js';

/**
 * Voice Teller speech templates (Stage 27, Innovation 6) — fixed
 * slot-filling templates per intent per locale. Templates NEVER generate
 * account data: every number/date spoken here was read from the
 * ledger/credit/vsla/voucher read models by VoiceTellerService and is
 * passed in as a slot. A read failure renders the `unavailable` template
 * instead — a stale or cached balance is never spoken as current.
 *
 * ha/yo/ig copy is a deterministic first pass (ASCII, loanword-heavy by
 * design so numbers/naira/kobo stay intelligible to TTS engines);
 * professional native-speaker recording/review is a content dependency.
 */

/** Outcome of a read-model lookup, per intent (service → template input). */
export type IntentAnswer =
  | { intent: 'balance.savings'; kind: 'ok'; balanceKobo: number }
  | { intent: 'balance.savings'; kind: 'no_account' }
  | { intent: 'balance.float'; kind: 'ok'; balanceKobo: number }
  | { intent: 'balance.float'; kind: 'not_agent' }
  | { intent: 'loan.next_installment'; kind: 'ok'; amountKobo: number; dueAt: string }
  | { intent: 'loan.next_installment'; kind: 'no_active_loan' }
  | { intent: 'loan.next_installment'; kind: 'no_installment' }
  | { intent: 'vsla.position'; kind: 'ok'; groupCount: number; totalKobo: number }
  | { intent: 'vsla.position'; kind: 'no_membership' }
  | { intent: 'voucher.status'; kind: 'ok'; status: InputVoucherStatus; amountKobo: number }
  | { intent: 'voucher.status'; kind: 'no_voucher' };

/** Spoken label per voucher status, per locale. */
const VOUCHER_STATUS_SPEECH: Readonly<Record<VoiceIntentLocale, Readonly<Record<InputVoucherStatus, string>>>> = {
  en: {
    ISSUED: 'issued and waiting to be distributed',
    REDEEMING: 'being redeemed right now',
    REDEEMED: 'already redeemed',
    EXPIRING: 'being expired',
    EXPIRED: 'expired',
    VOIDING: 'being voided',
    VOIDED: 'voided'
  },
  ha: {
    ISSUED: 'an fitar da ita, ana jiran rarrabawa',
    REDEEMING: 'ana karbar ta yanzu',
    REDEEMED: 'an riga an karbe ta',
    EXPIRING: 'tana karewa',
    EXPIRED: 'ta kare',
    VOIDING: 'ana soke ta',
    VOIDED: 'an soke ta'
  },
  yo: {
    ISSUED: 'ti a ti jade, n duro de pinpin',
    REDEEMING: 'a n gba a lowolowo',
    REDEEMED: 'a ti gba a tan',
    EXPIRING: 'o n pari',
    EXPIRED: 'o ti pari',
    VOIDING: 'a n fagilee',
    VOIDED: 'a ti fagilee'
  },
  ig: {
    ISSUED: 'eweputala ya, na-echekesa',
    REDEEMING: 'ana akporo ya ugbu a',
    REDEEMED: 'ekporola ya',
    EXPIRING: 'o na-agwu',
    EXPIRED: 'o gwula',
    VOIDING: 'ana akaghari ya',
    VOIDED: 'akagharila ya'
  }
};

type TemplateSet = Readonly<Record<VoiceIntentLocale, string>>;

/** Fills {slot} placeholders in a template — deterministic, no regex. */
function fill(template: string, slots: Readonly<Record<string, string>>): string {
  let out = template;
  for (const [key, value] of Object.entries(slots)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

const SAVINGS_OK: TemplateSet = {
  en: 'Your savings balance is {money}.',
  ha: 'Balankin ajiyar ku shine {money}.',
  yo: 'Balanse ifowopamo yin je {money}.',
  ig: 'Ego echekwara gi bu {money}.'
};

const SAVINGS_NONE: TemplateSet = {
  en: 'You do not have a savings account yet. Please visit an AgricPlatform agent to open one.',
  ha: 'Ba ku da asusun ajiya tukuna. Ku ziyarci wakilin AgricPlatform don bude asusu.',
  yo: 'E ko ni akanti ifowopamo sibere. E lo si alabasepo AgricPlatform lati sii.',
  ig: 'I nwebeghi akauntu echekwara. Gaakuru onye ozi AgricPlatform ka i meghee otu.'
};

const FLOAT_OK: TemplateSet = {
  en: 'Your agent float balance is {money}.',
  ha: 'Balankin float na wakili shine {money}.',
  yo: 'Balanse float alabasepo je {money}.',
  ig: 'Ego float gi dika onye ozi bu {money}.'
};

const FLOAT_NOT_AGENT: TemplateSet = {
  en: 'This number is not registered as an agent, so there is no float account.',
  ha: 'Ba a rajista wannan lamba a matsayin wakili ba, don haka babu asusun float.',
  yo: 'A ko forukowile nomba yii bi alabasepo, nitorina ko si akanti float.',
  ig: 'Edebeghi nomba a dika onye ozi, ya mere akauntu float adighi.'
};

const INSTALLMENT_OK: TemplateSet = {
  en: 'Your next loan installment is {money}, due on {date}.',
  ha: 'Biyan bashi na gaba shine {money}, ranar biya ita ce {date}.',
  yo: 'Sanwo gbese to nbo ni {money}, ojo ibiti o ye ni {date}.',
  ig: 'Ugwo mgbinye esote bu {money}, ubochi i kwu bu {date}.'
};

const INSTALLMENT_NO_LOAN: TemplateSet = {
  en: 'You have no active loan right now.',
  ha: 'Ba ku da bashi mai aiki a yanzu.',
  yo: 'E ko ni gbese to n sise lowolowo.',
  ig: 'I nweghi mgbinye na-aru oru ugbu a.'
};

const INSTALLMENT_NONE_PENDING: TemplateSet = {
  en: 'All installments on your active loan are already paid.',
  ha: 'An riga an biya dukkan biyan bashin ku.',
  yo: 'A ti san gbogbo awon bese lori gbese yin tan.',
  ig: 'Akwula ugwo mgbinye gi niile.'
};

const VSLA_OK: TemplateSet = {
  en: 'Your V S L A savings position across {groups} groups is {money}.',
  ha: 'Matsayin ajiyar ku a cikin kungiyoyin V S L A {groups} shine {money}.',
  yo: 'Ipo ifowopamo V S L A yin laarin awon egbe {groups} je {money}.',
  ig: 'Ego V S L A gi nime otu {groups} bu {money}.'
};

const VSLA_NONE: TemplateSet = {
  en: 'You are not an active member of any V S L A group.',
  ha: 'Ku ba ku cikin kungiyar V S L A mai aiki.',
  yo: 'E ko je egbe ninu egbe V S L A kankan to n sise.',
  ig: 'I abughi onye otu V S L A obula na-aru oru.'
};

const VOUCHER_OK: TemplateSet = {
  en: 'Your most recent input voucher for {money} is {status}.',
  ha: 'Baucar tallafi na karshe na {money} {status}.',
  yo: 'Faucha irawo to yin fun {money} {status}.',
  ig: 'Vaucha enyemaka ikpeazu maka {money} {status}.'
};

const VOUCHER_NONE: TemplateSet = {
  en: 'You have no input vouchers on record.',
  ha: 'Babu baucar tallafi a rajista a gare ku.',
  yo: 'Ko si faucha irawo kankan lori awo fun yin.',
  ig: 'Enweghi vaucha enyemaka edebere maka gi.'
};

const UNAVAILABLE: TemplateSet = {
  en: 'That service is unavailable right now. Please try again later.',
  ha: 'Wannan sabis ba ya samuwa a yanzu. Ku sake gwadawa an jima.',
  yo: 'Ise yen ko wa lowolowo. E tun gbiyanju laipe.',
  ig: 'Ozi ahu adighi ugbu a. Biko nwaa ozo mgbe e mesiri.'
};

const PIN_WRONG: TemplateSet = {
  en: 'That PIN is not correct.',
  ha: 'Wannan PIN ba daidai ba ne.',
  yo: 'PIN yen ko pe.',
  ig: 'PIN ahu adabughi.'
};

const PIN_LOCKED: TemplateSet = {
  en: 'This profile is locked after too many wrong PINs. Please try again after fifteen minutes.',
  ha: 'An kulle wannan bayanin bayan yunkurin PIN marar daidai da yawa. Ku sake gwadawa bayan minti goma sha biyar.',
  yo: 'A ti ti profaili yii pa leyin gbogbo gbiyanju PIN to je aijye. E tun gbiyanju leyin iseju marundinlogun.',
  ig: 'Agbachiela profailu a nhi onu ogugu PIN na-ezighi ezi. Nwaa ozo mgbe nkeji iri na ise gachara.'
};

const PIN_NOT_SET: TemplateSet = {
  en: 'You have not set up a security PIN. Please set your PIN in the AgricPlatform app, or ask your agent for help.',
  ha: 'Ba ku kafa PIN na tsaro ba tukuna. Ku kafa PIN a cikin app na AgricPlatform, ko ku nemi taimakon wakili.',
  yo: 'E ko ti seto PIN aabo. E seto PIN yin ninu app AgricPlatform, tabi e beere iranlowo lodo alabasepo.',
  ig: 'I setubeghi PIN nchekwa. Seta PIN gi nime ngwa AgricPlatform, ka onye ozi gi nyere gi aka.'
};

const NOT_REGISTERED: TemplateSet = {
  en: 'This phone number is not registered on AgricPlatform. Please register first, then call again.',
  ha: 'Ba a rajista wannan lambar waya a AgricPlatform ba. Ku yi rajista da farko, saan nan ku kira sake.',
  yo: 'A ko forukowile nomba fonu yii lori AgricPlatform. E forukowile ni akoko, ki e si pe pada.',
  ig: 'Edebeghi nomba ekwenti a na AgricPlatform. Biko debanye aha mbu, wee kpo ozo.'
};

function pick(set: TemplateSet, locale?: string): string {
  return set[normalizeVoiceIntentLocale(locale)];
}

/** Renders the spoken answer for a resolved intent (slots filled, never generated). */
export function renderIntentAnswer(answer: IntentAnswer, locale?: string): string {
  const resolved: VoiceIntentLocale = normalizeVoiceIntentLocale(locale);
  switch (answer.kind) {
    case 'ok':
      switch (answer.intent) {
        case 'balance.savings':
          return fill(pick(SAVINGS_OK, resolved), { money: speakMoneyKobo(answer.balanceKobo, resolved) });
        case 'balance.float':
          return fill(pick(FLOAT_OK, resolved), { money: speakMoneyKobo(answer.balanceKobo, resolved) });
        case 'loan.next_installment':
          return fill(pick(INSTALLMENT_OK, resolved), {
            money: speakMoneyKobo(answer.amountKobo, resolved),
            date: speakDate(answer.dueAt, resolved)
          });
        case 'vsla.position':
          return fill(pick(VSLA_OK, resolved), {
            groups: String(answer.groupCount),
            money: speakMoneyKobo(answer.totalKobo, resolved)
          });
        case 'voucher.status':
          return fill(pick(VOUCHER_OK, resolved), {
            money: speakMoneyKobo(answer.amountKobo, resolved),
            status: VOUCHER_STATUS_SPEECH[resolved][answer.status]
          });
      }
      break;
    case 'no_account':
      return pick(SAVINGS_NONE, resolved);
    case 'not_agent':
      return pick(FLOAT_NOT_AGENT, resolved);
    case 'no_active_loan':
      return pick(INSTALLMENT_NO_LOAN, resolved);
    case 'no_installment':
      return pick(INSTALLMENT_NONE_PENDING, resolved);
    case 'no_membership':
      return pick(VSLA_NONE, resolved);
    case 'no_voucher':
      return pick(VOUCHER_NONE, resolved);
  }
}

/** Spoken when the read model throws — never a cached/stale value. */
export function renderUnavailable(locale?: string): string {
  return pick(UNAVAILABLE, locale);
}

export function renderPinWrong(locale?: string): string {
  return pick(PIN_WRONG, locale);
}

export function renderPinLocked(locale?: string): string {
  return pick(PIN_LOCKED, locale);
}

export function renderPinNotSet(locale?: string): string {
  return pick(PIN_NOT_SET, locale);
}

export function renderNotRegistered(locale?: string): string {
  return pick(NOT_REGISTERED, locale);
}
