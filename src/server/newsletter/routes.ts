import { ok, obj, route } from "../router.ts";
import type { Route } from "../router.ts";
import { validation } from "../errors.ts";
import { audienceStats, postStats, postsCsv } from "./analytics.ts";
import { automationStats, createAutomation, deleteAutomation, getAutomation, listAutomations, listRuns, recordCustomEvent, setAutomationStatus, updateAutomation } from "./automations.ts";
import { baseUrl, getPublication, isLocalUrl, updatePublication } from "./publication.ts";
import { createPage, deletePage, getPage, listPages, updatePage } from "./pages.ts";
import { createPoll, deletePoll, getPoll, listPolls, updatePoll, createSurvey, deleteSurvey, getSurvey, listSurveys, surveyCsv, surveyResults, updateSurvey } from "./polls.ts";
import { createPost, deletePost, deleteTemplate, duplicatePost, getPost, listPosts, listTemplates, previewPost, saveTemplate, schedulePost, sendTest, setPublished, unschedulePost, updatePost } from "./posts.ts";
import { createReward, deleteReward, fulfillClaim, listClaims, listRewards, referralOverview, updateReward } from "./referrals.ts";
import { FIELD_CATALOG, changeMembers, createSegment, deleteSegment, getSegment, listSegments, previewRules, snapshotSegment, updateSegment } from "./segments.ts";
import { createSubscriber, deleteSubscriber, exportCsv, findById, importCsv, listFieldDefs, listSubscribers, listTags, saveFieldDef, subscriberActivity, subscriberView, updateSubscriber } from "./subscribers.ts";
import { listUploads, saveUpload } from "./uploads.ts";
import { renderPostWeb } from "./site.ts";

const csv = (name: string, body: string) => ({ status: 200, body: null, raw: body, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });

export const newsletterRoutes: Route[] = [
  // ---- publication ----
  route("GET", "/publication", (c) => {
    const pub = getPublication(c.db);
    const base = baseUrl(c.db, c.cfg, pub);
    return ok({ ...pub, base_url: base, base_url_is_local: isLocalUrl(base), mode: c.cfg.mode });
  }),
  route("PATCH", "/publication", (c) => ok(updatePublication(c.db, obj(c.body)))),

  // ---- subscribers ----
  route("GET", "/subscribers/export.csv", (c) => csv("subscribers.csv", exportCsv(c.db, { status: c.query.get("status") ?? undefined, tag: c.query.get("tag") ?? undefined, segment: c.query.get("segment") ?? undefined }))),
  route("POST", "/subscribers/import", (c) => {
    const b = obj(c.body);
    return ok(importCsv(c.db, c.cfg, b.csv, { status: b.status === "pending" ? "pending" : "active", tags: Array.isArray(b.tags) ? b.tags.map(String) : [], update_existing: b.update_existing === true }));
  }),
  route("GET", "/subscribers", (c) => ok(listSubscribers(c.db, c.cfg, {
    q: c.query.get("q") ?? undefined, status: c.query.get("status") ?? undefined, tag: c.query.get("tag") ?? undefined, segment: c.query.get("segment") ?? undefined,
    engagement: c.query.get("engagement") ?? undefined, limit: Number(c.query.get("limit") ?? 25) || 25, after: c.query.get("after") ?? undefined,
  }))),
  route("POST", "/subscribers", (c) => {
    const b = obj(c.body);
    const { subscriber, created } = createSubscriber(c.db, c.cfg, {
      email: b.email, fields: b.fields, tags: Array.isArray(b.tags) ? b.tags : undefined, country: b.country as string | undefined, source: "api",
      utm_source: b.utm_source as string | undefined, utm_medium: b.utm_medium as string | undefined, utm_campaign: b.utm_campaign as string | undefined,
      referrer: b.referrer as string | undefined, ref: b.referral_code as string | undefined,
      status: b.send_confirmation === true ? "pending" : "active", resubscribe: b.reactivate === true, welcome: b.send_welcome_email === true,
    });
    c.kick();
    return ok({ ...subscriberView(c.db, subscriber, baseUrl(c.db, c.cfg)), created }, created ? 201 : 200);
  }),
  route("GET", "/subscribers/:id", (c) => ok(subscriberView(c.db, findById(c.db, decodeURIComponent(c.params[0])), baseUrl(c.db, c.cfg)))),
  route("GET", "/subscribers/:id/activity", (c) => ok(subscriberActivity(c.db, decodeURIComponent(c.params[0])))),
  route("PATCH", "/subscribers/:id", (c) => ok(updateSubscriber(c.db, c.cfg, decodeURIComponent(c.params[0]), obj(c.body)))),
  route("DELETE", "/subscribers/:id", (c) => ok(deleteSubscriber(c.db, decodeURIComponent(c.params[0])))),
  route("GET", "/fields", (c) => ok({ fields: listFieldDefs(c.db), tags: listTags(c.db), catalog: FIELD_CATALOG })),
  route("POST", "/fields", (c) => ok(saveFieldDef(c.db, obj(c.body)), 201)),

  // ---- segments ----
  route("GET", "/segments", (c) => ok({ object: "list", data: listSegments(c.db) })),
  route("POST", "/segments", (c) => ok(createSegment(c.db, obj(c.body)), 201)),
  route("POST", "/segments/preview", (c) => ok(previewRules(c.db, obj(c.body).rules))),
  route("GET", "/segments/:id", (c) => ok(getSegment(c.db, c.params[0]))),
  route("PATCH", "/segments/:id", (c) => ok(updateSegment(c.db, c.params[0], obj(c.body)))),
  route("DELETE", "/segments/:id", (c) => ok(deleteSegment(c.db, c.params[0]))),
  route("POST", "/segments/:id/snapshot", (c) => ok(snapshotSegment(c.db, c.params[0]), 201)),
  route("POST", "/segments/:id/members", (c) => ok(changeMembers(c.db, c.params[0], obj(c.body)))),

  // ---- posts and templates ----
  route("GET", "/posts", (c) => ok(listPosts(c.db, c.cfg, c.query))),
  route("POST", "/posts", (c) => ok(createPost(c.db, c.cfg, obj(c.body ?? {})), 201)),
  route("GET", "/posts/:id", (c) => ok(getPost(c.db, c.cfg, c.params[0]))),
  route("PATCH", "/posts/:id", (c) => ok(updatePost(c.db, c.cfg, c.params[0], obj(c.body)))),
  route("DELETE", "/posts/:id", (c) => ok(deletePost(c.db, c.params[0]))),
  route("POST", "/posts/:id/duplicate", (c) => ok(duplicatePost(c.db, c.cfg, c.params[0]), 201)),
  route("POST", "/posts/:id/schedule", (c) => { const r = schedulePost(c.db, c.cfg, c.params[0], (c.body as Record<string, unknown>) ?? {}); c.kick(); return ok(r); }),
  route("POST", "/posts/:id/unschedule", (c) => ok(unschedulePost(c.db, c.cfg, c.params[0]))),
  route("POST", "/posts/:id/publish", (c) => ok(setPublished(c.db, c.cfg, c.params[0], true))),
  route("POST", "/posts/:id/unpublish", (c) => ok(setPublished(c.db, c.cfg, c.params[0], false))),
  route("POST", "/posts/:id/preview", (c) => {
    const b = (c.body as Record<string, unknown>) ?? {};
    return ok(b.mode === "web" ? renderPostWeb(c.db, c.cfg, c.params[0], b) : previewPost(c.db, c.cfg, c.params[0], b));
  }),
  route("POST", "/posts/:id/test", (c) => { const r = sendTest(c.db, c.cfg, c.params[0], obj(c.body)); c.kick(); return ok(r); }),
  route("GET", "/posts/:id/stats", (c) => ok(postStats(c.db, c.params[0]))),
  route("GET", "/templates", (c) => ok(listTemplates(c.db))),
  route("POST", "/templates", (c) => ok(saveTemplate(c.db, obj(c.body)), 201)),
  route("DELETE", "/templates/:id", (c) => ok(deleteTemplate(c.db, c.params[0]))),

  // ---- website pages ----
  route("GET", "/pages", (c) => ok(listPages(c.db))),
  route("POST", "/pages", (c) => ok(createPage(c.db, obj(c.body)), 201)),
  route("GET", "/pages/:id", (c) => ok(getPage(c.db, c.params[0]))),
  route("PATCH", "/pages/:id", (c) => ok(updatePage(c.db, c.params[0], obj(c.body)))),
  route("DELETE", "/pages/:id", (c) => ok(deletePage(c.db, c.params[0]))),

  // ---- polls and surveys ----
  route("GET", "/polls", (c) => ok(listPolls(c.db))),
  route("POST", "/polls", (c) => ok(createPoll(c.db, obj(c.body)), 201)),
  route("GET", "/polls/:id", (c) => ok(getPoll(c.db, c.params[0]))),
  route("PATCH", "/polls/:id", (c) => ok(updatePoll(c.db, c.params[0], obj(c.body)))),
  route("DELETE", "/polls/:id", (c) => ok(deletePoll(c.db, c.params[0]))),
  route("GET", "/surveys", (c) => ok(listSurveys(c.db))),
  route("POST", "/surveys", (c) => ok(createSurvey(c.db, obj(c.body)), 201)),
  route("GET", "/surveys/:id", (c) => ok(surveyResults(c.db, c.params[0]))),
  route("GET", "/surveys/:id/export.csv", (c) => csv("survey.csv", surveyCsv(c.db, c.params[0]))),
  route("PATCH", "/surveys/:id", (c) => ok(updateSurvey(c.db, c.params[0], obj(c.body)))),
  route("DELETE", "/surveys/:id", (c) => ok(deleteSurvey(c.db, c.params[0]))),

  // ---- referrals ----
  route("GET", "/referrals", (c) => ok(referralOverview(c.db))),
  route("GET", "/rewards", (c) => ok(listRewards(c.db))),
  route("POST", "/rewards", (c) => ok(createReward(c.db, obj(c.body)), 201)),
  route("PATCH", "/rewards/:id", (c) => ok(updateReward(c.db, c.params[0], obj(c.body)))),
  route("DELETE", "/rewards/:id", (c) => ok(deleteReward(c.db, c.params[0]))),
  route("GET", "/rewards/claims", (c) => ok(listClaims(c.db, c.query.get("status")))),
  route("POST", "/rewards/claims/:id/fulfill", (c) => ok(fulfillClaim(c.db, c.params[0]))),

  // ---- automations and events ----
  route("GET", "/automations", (c) => ok(listAutomations(c.db))),
  route("POST", "/automations", (c) => ok(createAutomation(c.db, obj(c.body)), 201)),
  route("GET", "/automations/:id", (c) => ok({ ...getAutomation(c.db, c.params[0]), stats: automationStats(c.db, c.params[0]) })),
  route("PATCH", "/automations/:id", (c) => ok(updateAutomation(c.db, c.params[0], obj(c.body)))),
  route("DELETE", "/automations/:id", (c) => ok(deleteAutomation(c.db, c.params[0]))),
  route("POST", "/automations/:id/activate", (c) => ok(setAutomationStatus(c.db, c.cfg, c.params[0], "live"))),
  route("POST", "/automations/:id/pause", (c) => ok(setAutomationStatus(c.db, c.cfg, c.params[0], "paused"))),
  route("GET", "/automations/:id/runs", (c) => ok(listRuns(c.db, c.params[0], c.query.get("status")))),
  route("POST", "/events", (c) => ok(recordCustomEvent(c.db, c.cfg, obj(c.body)), 201)),

  // ---- analytics, uploads, forms ----
  route("GET", "/analytics/audience", (c) => ok(audienceStats(c.db, Math.min(Math.max(Number(c.query.get("days") ?? 30) || 30, 7), 365)))),
  route("GET", "/analytics/posts.csv", (c) => csv("posts.csv", postsCsv(c.db))),
  route("GET", "/uploads", (c) => ok(listUploads(c.db))),
  route("POST", "/uploads", (c) => ok(saveUpload(c.db, c.cfg, obj(c.body)), 201)),
  route("GET", "/forms", (c) => {
    const base = baseUrl(c.db, c.cfg);
    const src = `${base}/embed.js`;
    if (!/^https?:\/\//.test(base)) throw validation("Set the public URL first");
    return ok({
      base_url: base, base_url_is_local: isLocalUrl(base), hosted_page: `${base}/subscribe`,
      iframe: `<iframe src="${base}/subscribe?embed=1" width="100%" height="260" style="border:0;max-width:520px" title="Subscribe"></iframe>`,
      inline: `<div data-freepost-form></div>\n<script async src="${src}"></script>`,
      popup: `<script async src="${src}" data-mode="popup" data-delay="8"></script>`,
      exit_intent: `<script async src="${src}" data-mode="popup" data-trigger="exit"></script>`,
      slide_in: `<script async src="${src}" data-mode="slide-in" data-delay="12"></script>`,
    });
  }),
];
