/**
 * The invitation SMS, word for word.
 *
 * One definition, read by the auth function (which sends it) and by the
 * staff screen (which shows the manager what went and offers it to copy):
 * the two must never drift, because the screen's whole claim is "this is
 * what they were sent". No Deno import here, so test/invite-message.test.mjs
 * can hold it to account the way tillai/tools.ts is.
 *
 * Every character is in the GSM 7-bit set, on purpose. One character outside
 * it — a curly quote, an em dash — makes the network send the whole message
 * as UCS-2, which halves the room per segment and doubles what the shop
 * pays. The unit test checks this and the length; the message must fit in
 * two segments with the longest number the invite RPC accepts.
 */
export const DEFAULT_ENROL_URL = "https://pos.innovaearth.com/enrol/";

export function inviteMessage(phone: string, enrolUrl: string = DEFAULT_ENROL_URL): string {
  return (
    `You have been added to the till at work. ` +
    `Go to ${enrolUrl} and enter your number ${phone} - ` +
    `you will get an SMS code, and then you choose your own PIN.`
  );
}
