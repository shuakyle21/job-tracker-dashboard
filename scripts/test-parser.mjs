#!/usr/bin/env node
/**
 * Runs n8n/parse-email.js outside n8n against real email shapes.
 *
 * Why this exists: the parser is the only real logic in the workflow, and the
 * alternative to testing it here is testing it in production, one wrong row at
 * a time. The code-node body reads `$json` and returns `{ json }`, so wrapping
 * it in a Function with `$json` as the single argument runs it exactly as n8n
 * does — no mocking, no n8n needed.
 *
 *   node scripts/test-parser.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const source = await readFile(join(ROOT, "n8n/parse-email.js"), "utf8");
// eslint-disable-next-line no-new-func
const parse = new Function("$json", source);

let failures = 0;
function expect(label, got, want) {
  const ok = got === want;
  if (ok) console.log(`  ok    ${label}`);
  else {
    console.error(`  FAIL  ${label}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);
    failures++;
  }
}

function email(over = {}) {
  return {
    id: "msg-1", threadId: "thr-1", date: "2026-09-15T04:12:00.000Z",
    subject: "", from: { value: [{ address: "x@example.com", name: "" }] },
    text: "", ...over,
  };
}

const cases = [
  {
    name: "LinkedIn application sent",
    input: email({
      subject: "Your application was sent to Acme Robotics",
      from: { value: [{ address: "jobs-noreply@linkedin.com", name: "LinkedIn" }] },
      // LinkedIn's real layout: company, then the title on its own line.
      text: "Your application was sent to Acme Robotics\n\nBackend Engineer\nAcme Robotics\nMandaluyong",
    }),
    want: { status: "applied", source: "LinkedIn", parsed: true, max_stage: 1 },
  },
  {
    name: "LinkedIn viewed by employer",
    input: email({
      subject: "Your application was viewed by Northwind Labs",
      from: { value: [{ address: "jobs-noreply@linkedin.com", name: "LinkedIn" }] },
      text: "Northwind Labs viewed your application for Data Engineer.",
    }),
    want: { status: "viewed by employer", max_stage: 2 },
  },
  {
    // The case that breaks naive classifiers: a rejection that mentions the
    // interview it followed. Status must be the rejection; the funnel must
    // still see stage 4.
    name: "rejection after an interview",
    input: email({
      subject: "Update on your application — Product Engineer at Stride",
      from: { value: [{ address: "careers@stride-site.com", name: "Stride Careers" }] },
      text: "Thank you for interviewing with us last week. Unfortunately we have decided not to move forward.",
    }),
    want: { status: "rejected", max_stage: 4, company: "Stride" },
  },
  {
    name: "rejection after review only",
    input: email({
      subject: "Your application to Yngen Datacom",
      from: { value: [{ address: "hr@yngen.com.ph", name: "Yngen Datacom HR" }] },
      text: "After reviewing your application, unfortunately you were not selected.",
    }),
    want: { status: "rejected", max_stage: 2 },
  },
  {
    name: "interview invitation",
    input: email({
      subject: "Invitation to interview — Full Stack Developer at Q2Q Technologies",
      from: { value: [{ address: "talent@q2q.com", name: "Q2Q Technologies Talent" }] },
      text: "Please pick a time on https://calendly.com/q2q/interview",
    }),
    want: { status: "interview scheduled", max_stage: 4, job_title: "Full Stack Developer", company: "Q2Q Technologies" },
  },
  {
    name: "assessment invitation",
    input: email({
      subject: "Next steps: coding challenge for AI Automation Specialist",
      from: { value: [{ address: "no-reply@greenhouse.io", name: "Access Offshoring Recruiting" }] },
      text: "Please complete the take-home exercise within 72 hours.",
    }),
    // No interview is mentioned, so stage evidence stops at 3. Asserting 4
    // here would be asserting a bug.
    want: { status: "assessment", max_stage: 3 },
  },
  {
    name: "offer",
    input: email({
      subject: "Offer of employment — Backend Engineer",
      from: { value: [{ address: "people@flyrank.ai", name: "FlyRank AI" }] },
      text: "We are pleased to offer you the position. Offer letter attached.",
    }),
    want: { status: "offer", max_stage: 5, company: "FlyRank AI" },
  },
  {
    name: "talent pool",
    input: email({
      subject: "Thank you for your interest in BruntWork",
      from: { value: [{ address: "careers@bruntwork.co", name: "BruntWork Careers" }] },
      text: "We will keep your resume on file for future opportunities.",
    }),
    want: { status: "talent pool", max_stage: 2 },
  },
  {
    // Newsletters, invoices and recruiter spam all land here. The important
    // property is that it does not silently become a tracker row.
    name: "unrelated email goes to needs-review",
    input: email({
      subject: "Your weekly digest",
      from: { value: [{ address: "digest@medium.com", name: "Medium Daily Digest" }] },
      text: "Here are stories we think you will like.",
    }),
    want: { parsed: false, status: "", confidence: "low" },
  },
  {
    name: "known status but unknown company still routes to review",
    input: email({
      subject: "Application received",
      from: { value: [{ address: "no-reply@myworkday.com", name: "no-reply" }] },
      text: "Thank you for applying.",
    }),
    // "Application received" strips to nothing and the Workday domain says
    // nothing about the employer, so neither company nor title survives —
    // low, not medium. The row still reaches needs-review with its subject.
    want: { parsed: false, confidence: "low", status: "applied" },
  },
  // --- real sender shapes from the "Job Application" label (names changed) ---
  {
    name: "JobStreet submitted",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "Hi Alex, your application for Software Automation Developer was successfully submitted to Deltaworks Systems (Philippines), Ltd.\nView your application",
    }),
    want: { status: "applied", job_title: "Software Automation Developer", company: "Deltaworks Systems (Philippines), Ltd.",
      job_platform: "JobStreet", status_label: "Applied", parsed: true,
      application_key: "deltaworks systems (philippines), ltd.|software automation developer" },
  },
  {
    // Same application as above, different Gmail thread (a later status-update
    // email rarely lands in the original thread). Company is known, so the
    // key must not include thread_id — it has to match the first email's key
    // or the forward-merge in merge-feed.js can never find this application.
    name: "JobStreet submitted, different thread, same application_key",
    input: email({
      threadId: "thr-different",
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "Hi Alex, your application for Software Automation Developer was successfully submitted to Deltaworks Systems (Philippines), Ltd.\nView your application",
    }),
    want: { application_key: "deltaworks systems (philippines), ltd.|software automation developer" },
  },
  {
    name: "JobStreet viewed",
    input: email({
      subject: "Acme Group has viewed your application for AI Developer",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "You're getting noticed! Acme Group viewed your application for AI Developer.",
    }),
    want: { status: "viewed by employer", company: "Acme Group", job_title: "AI Developer", status_label: "Viewed", max_stage: 2 },
  },
  {
    // Real production bug: a title long enough to wrap onto a second line
    // breaks the single-line JobStreet extractor (`.` doesn't cross `\n`), and
    // JobStreet's own safety disclaimer ("...when applying for a job.") used to
    // win the fallback race, extracting the article "a" as the job title.
    name: "JobStreet submitted, title wraps to a second line",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "Hi Alex, your application for Web Developer – AI & Automation Specialist\n"
        + "| AU Client - WFH was successfully submitted to SourceU\n\n"
        + "Each employer's recruitment process is different, so you might not always "
        + "hear from them.\n\n"
        + "Never provide your bank or credit card details when applying for a job.\n",
    }),
    want: { status: "applied", job_title: "Web Developer – AI & Automation Specialist | AU Client - WFH",
      company: "SourceU", job_platform: "JobStreet", status_label: "Applied", parsed: true,
      application_key: "sourceu|web developer – ai & automation specialist|au client - wfh" },
  },
  {
    name: "LinkedIn sent (title on the next line)",
    input: email({
      subject: "Alex, your application was sent to Quikly Staffing",
      from: { value: [{ address: "jobs-noreply@linkedin.com", name: "LinkedIn" }] },
      text: "Your application was sent to Quikly Staffing\n\nBackend Software Developer (Remote)\nQuikly Staffing\nPhilippines\nView job: https://example.test",
    }),
    want: { status: "applied", company: "Quikly Staffing", job_title: "Backend Software Developer (Remote)",
      job_platform: "LinkedIn", parsed: true },
  },
  {
    // Indeed's confirmation never names the employer. Without a company there
    // is no reliable `company|role` key, so it stops at Needs Review instead
    // of creating a Feed row that nothing else can ever match.
    name: "Indeed application, no company → Needs Review",
    input: email({
      subject: "Indeed Application: REMOTE - Full Stack Engineer",
      from: { value: [{ address: "indeedapply@indeed.com", name: "Indeed Apply" }] },
      text: "Your application has been submitted. Good luck!",
    }),
    want: { status: "applied", job_title: "REMOTE - Full Stack Engineer", company: "", job_platform: "Indeed",
      parsed: false, status_label: "Needs Review", application_key: "" },
  },
  {
    // Real Feed row: "jobstreet|web developer – ai & automation specialist|<thread>".
    // A board confirmation whose extractors missed the employer is the same case.
    name: "JobStreet, company not found → Needs Review",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "Hi Alex, your application for Web Developer was received.",
    }),
    want: { company: "", parsed: false, status_label: "Needs Review", application_key: "" },
  },
  {
    // Real duplicate: VA Masters' "Developer & Automation Expert" got two Feed
    // rows. Invisible characters copied out of an email (here a zero-width
    // space, as in a real Turnitin key) must not make an otherwise identical
    // key look different.
    name: "zero-width characters never reach the title or the key",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "Hi Alex, your application for \u200BDeveloper &\u00A0Automation Expert was successfully submitted to VA Masters\uFEFF\nView your application",
    }),
    want: { job_title: "Developer & Automation Expert", company: "VA Masters", parsed: true,
      application_key: "va masters|developer & automation expert" },
  },
  {
    // The other three invisible characters the parser strips: zero-width
    // non-joiner, zero-width joiner and word joiner.
    name: "zero-width joiners and word joiners never reach the key",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "Hi Alex, your application for Developer‌ &⁠ Automation‍ Expert was successfully submitted to VA Masters\nView your application",
    }),
    want: { job_title: "Developer & Automation Expert", company: "VA Masters", parsed: true,
      application_key: "va masters|developer & automation expert" },
  },
  {
    // A key with an empty part ("acme|ai developer|") would make Merge Into
    // Feed fail the whole execution. The parser catches it first and routes
    // the email to Needs Review, so that failure stays a last resort.
    name: "title ending in a separator → Needs Review",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "Hi Alex, your application for AI Developer | was successfully submitted to Acme Group\nView",
    }),
    want: { company: "Acme Group", parsed: false, status_label: "Needs Review", application_key: "" },
  },
  {
    // A title that itself contains "|" is keyed without spaces around it, the
    // same canonical form Find Feed Row reduces a hand-typed key to.
    name: "pipes inside a title are keyed without surrounding spaces",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet" }] },
      text: "Hi Alex, your application for AI Finance Support Specialist | WFH was successfully submitted to Intogreat Solutions\nView",
    }),
    want: { application_key: "intogreat solutions|ai finance support specialist|wfh" },
  },
  {
    name: "Workable ATS",
    input: email({
      subject: "Thanks for applying to CentralCo",
      from: { value: [{ address: "noreply@candidates.workablemail.com", name: "CentralCo" }] },
      text: "Your application for the Product Engineer job was submitted successfully.",
    }),
    want: { status: "applied", job_title: "Product Engineer", company: "CentralCo", job_platform: "Company Website", parsed: true },
  },
  {
    name: "Lever ATS",
    input: email({
      subject: "Thank you for your application to Binaryco",
      from: { value: [{ address: "no-reply@hire.lever.co", name: "Binaryco" }] },
      text: "Hi Alex, Thank you for your interest in Binaryco! We have received your application for Junior Software Engineer, and we are delighted.",
    }),
    want: { status: "applied", job_title: "Junior Software Engineer", company: "Binaryco", parsed: true },
  },
  {
    name: "Ashby ATS (title and company in one sentence)",
    input: email({
      subject: "Thanks for applying to Rasaco!",
      from: { value: [{ address: "no-reply@ashbyhq.com", name: "" }] },
      text: "Hi Alex, Thank you for applying for the Builder Cohort role at Rasaco! We appreciate your interest.",
    }),
    want: { status: "applied", job_title: "Builder Cohort", company: "Rasaco", parsed: true },
  },
  {
    name: "BambooHR ATS",
    input: email({
      subject: "Thank you for applying at Brightlives Productions!",
      from: { value: [{ address: "notifications@app.bamboohr.com", name: "Brightlives Productions" }] },
      text: "Thank you for your interest in Brightlives Productions and for taking the time to apply for the Automation & Workflow Specialist position.",
    }),
    want: { status: "applied", job_title: "Automation & Workflow Specialist", company: "Brightlives Productions", parsed: true },
  },
  {
    name: "Teamtailor ATS",
    input: email({
      subject: "We have received your application!",
      from: { value: [{ address: "ena@spotter.na.teamtailor-mail.com", name: "Spotterco" }] },
      text: "Thank you for your application. We will review your application for Remote Machine Learning Engineer shortly, and get back to you.",
    }),
    want: { status: "applied", job_title: "Remote Machine Learning Engineer", company: "Spotterco", parsed: true },
  },
  {
    // Manatal mail comes from a recruiter's personal name; the body names the employer.
    name: "Manatal ATS, recruiter as sender",
    input: email({
      subject: "Your Application to Backend Developer",
      from: { value: [{ address: "kim.santos@mail.manatal.com", name: "Kim Santos" }] },
      text: "Thank you for your interest in joining Clarkco Outsourcing, the coolest workplace! This is to confirm that we have received your application for Backend Developer. If shortlisted we will call.",
    }),
    want: { status: "applied", job_title: "Backend Developer", company: "Clarkco Outsourcing", parsed: true },
  },
  {
    name: "application you sent yourself",
    input: email({
      subject: "Application for Junior Developer Position",
      labelIds: ["IMPORTANT", "SENT"],
      from: { value: [{ address: "me@gmail.com", name: "Alex" }] },
      to: { value: [{ address: "talents@meetmilla.com" }] },
      text: "Hello Milla Labs Team, I'm writing to express my interest in the Junior Developer position.",
    }),
    want: { status: "applied", job_title: "Junior Developer", company: "Meetmilla", job_platform: "Direct Email",
      status_label: "Applied", parsed: true },
  },
  {
    name: "SENT detected from the labels [{id}] shape",
    input: email({
      subject: "Application for Data Analyst",
      labels: [{ id: "SENT", name: "SENT" }],
      from: { value: [{ address: "me@gmail.com", name: "Alex" }] },
      to: { value: [{ address: "hr@northwind.ph" }] },
    }),
    want: { status: "applied", job_platform: "Direct Email", company: "Northwind" },
  },
  {
    name: "contact is the recipient for mail you sent to a gmail hiring manager",
    input: email({
      subject: "Application for Virtual Assistant",
      labelIds: ["SENT"],
      from: { value: [{ address: "me@gmail.com", name: "Alex" }] },
      to: { value: [{ address: "Jane.Doe@gmail.com", name: "Jane Doe" }] },
    }),
    want: { company: "", parsed: false, contact_name: "Jane Doe", contact_address: "jane.doe@gmail.com" },
  },
  {
    name: "contact is the sender for a hiring manager's reply",
    input: email({
      subject: "Re: Virtual Assistant",
      from: { value: [{ address: "jane.doe@gmail.com", name: "Jane Doe" }] },
      text: "Hi, send me your CV and I'll take a look.",
    }),
    want: { contact_name: "Jane Doe", contact_address: "jane.doe@gmail.com" },
  },
  {
    name: "rejection in the subject",
    input: email({
      subject: "Your application for the Software Developer role was not selected.",
      from: { value: [{ address: "no-reply@emaptaco.com", name: "" }] },
      text: "Thank you for taking the time to apply for the Software Developer opportunity.",
    }),
    want: { status: "rejected", job_title: "Software Developer", status_label: "Rejected" },
  },
  {
    name: "LinkedIn viewed",
    input: email({
      subject: "Your application was viewed by Webwave Digital",
      from: { value: [{ address: "jobs-noreply@linkedin.com", name: "LinkedIn" }] },
      text: "Your application was viewed by Webwave Digital\n\nData Ops Developer\nWebwave Digital",
    }),
    want: { status: "viewed by employer", company: "Webwave Digital", job_platform: "LinkedIn", status_label: "Viewed" },
  },
  {
    name: "Kalibrr sent",
    input: email({
      subject: "Application sent to Technical Consultant at DIRECO BUSINESS TECH INC.!",
      from: { value: [{ address: "support@kalibrr.com", name: "Kalibrr" }] },
      text: "Application sent! Your application has been successfully submitted.",
    }),
    want: { status: "applied", job_title: "Technical Consultant", company: "DIRECO BUSINESS TECH INC.", job_platform: "Kalibrr", parsed: true },
  },
  // --- misclassified in Oct 2026 (Feed rows fixed by hand on 2026-10-28) ---
  {
    // Workable sends as "Workable"; the employer is only in the subject.
    name: "Workable confirmation names the employer, not Workable",
    input: email({
      subject: "Thanks for applying to Brightdesk",
      from: { value: [{ address: "noreply@candidates.workablemail.com", name: "Workable" }] },
      text: "Brightdesk\n\nYour application for the Forward Deployed Engineer (Remote | US Hours) job was submitted successfully. Here's a copy of your application data for safekeeping.",
    }),
    want: { status: "applied", company: "Brightdesk", job_title: "Forward Deployed Engineer (Remote | US Hours)", parsed: true },
  },
  {
    // join.com: the subject's "a position at <C>" is not a job title.
    name: "JOIN confirmation takes the employer from the subject",
    input: email({
      subject: "We received your application for a position at Scalewise",
      from: { value: [{ address: "noreply@join.com", name: "JOIN" }] },
      text: "Hi Joshua,\n\nThank you for your application for this position: Automation Engineer\n\nWe will get back to you soon.",
    }),
    want: { status: "applied", company: "Scalewise", job_title: "Automation Engineer", parsed: true },
  },
  {
    // "interest in joining our team" names nobody. Better Needs Review than
    // a Feed row keyed "our team|...".
    name: "\"joining our team\" is not a company",
    input: email({
      subject: "Thank you for applying",
      from: { value: [{ address: "noreply@candidates.workablemail.com", name: "Workable" }] },
      text: "Thank you for your interest in joining our team, we have received your application for the Revenue Analyst role.",
    }),
    want: { company: "", parsed: false },
  },
  {
    // A recruiter writing from the company domain under their own name:
    // the subject's "@ <C>" matches the domain, so it beats the person's name.
    name: "recruiter's own name loses to the subject's company",
    input: email({
      subject: "Update on Your Application – Developer @ Polaris Software & Beyond",
      from: { value: [{ address: "jane@polaris.co.il", name: "Jane Doe" }] },
      text: "Hi Joshua,\n\nThank you for your time. Unfortunately, we have decided not to move forward with your application.",
    }),
    want: { status: "rejected", company: "Polaris Software & Beyond", job_title: "Developer", parsed: true },
  },
  {
    // Ashby: "<Company>: <Title>: Application Update".
    name: "Ashby application update after an interview",
    input: email({
      subject: "Northgate Ventures: Operations Engineer: Application Update",
      from: { value: [{ address: "talent@northgate.com", name: "Northgate Talent Engine" }] },
      text: "Hey Joshua, thanks again for interviewing with us. After looping in the team, we've decided not to move forward.",
    }),
    want: { status: "rejected", company: "Northgate Ventures", job_title: "Operations Engineer", max_stage: 4, parsed: true },
  },
  {
    name: "Ashby interview confirmation",
    input: email({
      subject: "Interview Confirmation - Northgate Ventures",
      from: { value: [{ address: "no-reply@ashbyhq.com", name: "Northgate Ventures" }] },
      text: "Hi Joshua, Sending here the new link for your initial interview for the Operations Engineer at Northgate Ventures. We're looking forward to connecting with you!",
    }),
    want: { status: "interview scheduled", company: "Northgate Ventures", job_title: "Operations Engineer", parsed: true },
  },
  {
    // Indeed wraps its HTML at fixed widths, so a rejection phrase can be
    // split across a line break. The later "future openings" must not win.
    name: "rejection split across a line break beats \"future openings\"",
    input: email({
      subject: "An update on your application from Peoplewise",
      from: { value: [{ address: "noreply@indeed.com", name: "Indeed" }] },
      text: "Thank you for taking the time to apply for the AI Solutions Engineer position at Peoplewise.\n\nAfter carefully reviewing your application, we've decided to move forward with\nother candidates. While we won't be moving forward with your application for\nthis role, we encourage you to apply for future openings.",
    }),
    want: { status: "rejected", company: "Peoplewise", job_title: "AI Solutions Engineer", parsed: true },
  },
  {
    name: "\"won't be moving forward\" alone is a rejection",
    input: email({
      subject: "Your application to Brightdesk",
      from: { value: [{ address: "hr@brightdesk.io", name: "Brightdesk HR" }] },
      text: "We won't be moving forward with your application at this time. We'll keep your details for future openings.",
    }),
    want: { status: "rejected" },
  },
  {
    name: "unparsed mail is labelled Needs Review",
    input: email({
      subject: "Your weekly digest",
      from: { value: [{ address: "digest@medium.com", name: "Medium Daily Digest" }] },
      text: "Here are stories we think you will like.",
    }),
    want: { status_label: "Needs Review", job_platform: "Company Website" },
  },
  // The rest came from Feed duplicates: each of these once wrote a second row
  // for an application that already had one, under a boilerplate "title".
  {
    // LinkedIn's "viewed" mail names no job. The subject is not a title, and a
    // key built from it starts a row no other email about the job will match.
    name: "LinkedIn viewed with no job named stays unparsed",
    input: email({
      subject: "Your application was viewed by Emerson",
      from: { value: [{ address: "jobs-noreply@linkedin.com", name: "LinkedIn" }] },
      text: "----------------------------------------\n\nThis email was intended for Joshua Klyne Pudadera",
    }),
    want: { job_title: "", parsed: false },
  },
  {
    name: "SmartRecruiters 'the position of <T>'",
    input: email({
      subject: "Thank you for applying to Arch Global Services (Philippines) Inc.",
      from: { value: [{ address: "notification@smartrecruiters.com", name: "Arch Global Services (Philippines) Inc. Hiring Team" }] },
      text: "Dear Joshua Klyne,\n\nThank you for submitting your application for the position of 2026-7929 Data Engineer-Mid (Night Shift). Your application is queued for review and we will contact you shortly.",
    }),
    want: { application_key: "arch global services (philippines) inc.|2026-7929 data engineer-mid (night shift)" },
  },
  {
    name: "Avature 'the role of <T>' under a survey subject",
    input: email({
      subject: "Thank you and Survey Request",
      from: { value: [{ address: "talent@avature.lenovo.net", name: "Lenovo Talent" }] },
      text: "Hello Joshua,\n\n Thank you for your application to Lenovo.\n\n We appreciate you applying for the role of Data Analyst Intern. Your application has been received.",
    }),
    want: { application_key: "lenovo|data analyst intern" },
  },
  {
    name: "'New Application' subject, title in the body",
    input: email({
      subject: "New Application  |  Complete your profile now",
      from: { value: [{ address: "lisa@people2people.com.au", name: "people2people" }] },
      text: "Hi Joshua Klyne,\nThanks for applying for the position of Data Analyst. We'll review it and consider you for any other appropriate opportunities.",
    }),
    want: { application_key: "people2people|data analyst" },
  },
  {
    name: "micro1 'Update about your application for <T>'",
    input: email({
      subject: "Update about your application for Data Entry Keyer",
      from: { value: [{ address: "support@micro1.ai", name: "micro1" }] },
      text: "Hi Joshua Klyne,\n Thank you for completing your Data Entry Keyer AI interview with micro1. After a thorough review of your interview, we found that your results did not align with our certification criteria at this time.",
    }),
    want: { job_title: "Data Entry Keyer" },
  },
  {
    // A recruiter's own name as sender, a title hard-wrapped inside markdown.
    name: "recruiter-sent confirmation names the employer from the domain",
    input: email({
      subject: "STAFFVIRTUAL Application Received (JOSHUA PUDADERA)",
      from: { value: [{ address: "jessa@staffvirtual.com", name: "Jessa Grace Morelos" }] },
      text: "Greetings from STAFFVIRTUAL!\n\nWe would like to inform you that we have received your application for\nthe *Sales\nSupport Specialist (Advanced Excel | VLOOKUP & Pivot Tables) - Remote\n*position.\nWe appreciate your interest in our organization",
    }),
    want: { company: "STAFFVIRTUAL", job_title: "Sales Support Specialist (Advanced Excel | VLOOKUP & Pivot Tables) - Remote" },
  },
  {
    name: "Lever 'apply for the <T> at <C>!' and 'joining our team' is no employer",
    input: email({
      subject: "Thank you for your application to join Spreetail!",
      from: { value: [{ address: "no-reply@hire.lever.co", name: "Spreetail" }] },
      text: "Hi Joshua, \n\nThank you for taking the time to apply for the RPA & AI Automation Engineer at Spreetail! We appreciate your interest in joining our team and wanted to inform you your application is in the review stage.",
    }),
    want: { application_key: "spreetail|rpa & ai automation engineer" },
  },
  {
    // "chosen to proceed with other candidates" is a rejection, however warmly
    // it mentions the talent pool, and the company is not the job title.
    name: "Emapta 'chosen to proceed with other candidates'",
    input: email({
      subject: "Thanks for Applying to Emapta - Let’s stay connected!",
      from: { value: [{ address: "careers@emapta.com", name: "Emapta Careers" }] },
      // As n8n receives it: Gmail's text part, hard-wrapped at ~78 columns.
      text: "Thanks for Applying to Emapta - Let’s stay connected!\n\nDear Joshua Klyne Pudadera,\n\nThank you for expressing interest in the Analytics Engineer (Marketing\nAnalytics) | WFH | Night Shift | Day 1 HMO | Weekends Off role with us. We\ngenuinely appreciate the time and effort you have invested into your\napplication. However, after careful consideration, we've chosen to\nproceed with other candidates whose qualifications more closely align with the\nspecific requirements of the role at this time.\n\nAs we continuously cultivate our talent pool, we would like to retain your profile.",
    }),
    want: { status: "rejected", application_key: "emapta|analytics engineer (marketing analytics)|wfh|night shift|day 1 hmo|weekends off" },
  },
  {
    // Hard-wrapped body, and a display name without the "Inc." the email uses.
    name: "BambooHR wrapped body, company takes the email's legal name",
    input: email({
      subject: "Thank you for applying at Appficiency",
      from: { value: [{ address: "notifications@app.bamboohr.com", name: "Appficiency" }] },
      text: "Thanks Joshua Klyne!\n\nWe received your application.\n\nHi Joshua Klyne,\n\nThank you for your interest in Appficiency Inc. and for taking the time to apply\nfor the Junior Solutions Architect position. We just wanted to let you know that\nwe received your application.",
    }),
    want: { application_key: "appficiency inc.|junior solutions architect" },
  },
  {
    name: "iCIMS 'application to the <T> position at <C>'",
    input: email({
      subject: "Thank You For Your Application",
      from: { value: [{ address: "codev+autoreply@talent.icims.com", name: "CoDev @ icims" }] },
      text: "Hi Joshua Klyne, \n\nThank you for your recent application to the Full Stack React Developer (2026-3066) position at CoDev.\n \nYour submission will be reviewed.",
    }),
    want: { application_key: "codev|full stack react developer (2026-3066)" },
  },
  {
    // The title's own "–" is not the subject separator, and the only rejection
    // signal is the template name in LinkedIn's tracking links.
    name: "LinkedIn rejection 'Your application to <T> at <C>'",
    input: email({
      subject: "Your application to Venture Factory Software Engineer Level I – Java/Python/AI (Work From Home)  at Nelnet Philippines Inc",
      from: { value: [{ address: "jobs-noreply@linkedin.com", name: "LinkedIn" }] },
      text: "Your update from Nelnet Philippines Inc\n\n----\n\nLearn why we included this: https://www.linkedin.com/help/linkedin/answer/4788?lang=en&lipi=urn%3Ali%3Apage%3Aemail_email_jobs_application_rejected_01%3BOlxA",
    }),
    want: { status: "rejected", application_key: "nelnet philippines inc|venture factory software engineer level i – java/python/ai (work from home)" },
  },
  {
    // A reply thread: the quoted history names the job in half-sentences, and
    // the subject's title is cut at a bracket. Neither is a title.
    name: "reply thread with quoted history stays unparsed",
    input: email({
      subject: "Re: [Applicant - IRDSS Project] Project Technical Assistant III_Pudadera",
      from: { value: [{ address: "diwa.upmin@up.edu.ph", name: "Mindanao Center for Disease Watch and Analytics UP Mindanao" }] },
      text: "Thank you for taking the time to apply at the DiWA Center.\n\nFollowing your non-attendance at the scheduled interview slot, we are\nmoving forward with other candidates.\n\nOn Wed, Jun 17, 2026 at 9:00 AM Joshua Klyne Pudadera <me@example.com>\nwrote:\n\n> I am applying for the Project Technical Assistant II for the project.",
    }),
    want: { status: "rejected", job_title: "", parsed: false },
  },
  {
    name: "Teamtailor 'Name - Company' sender and 'the role of <T>'",
    input: email({
      subject: "Thank you for your application!",
      from: { value: [{ address: "edgar.deocadiz@burt.teamtailor-mail.com", name: "Edgar Deocadiz - Burt Intelligence" }] },
      text: "Thank you for sending in your application for the role of Solutions Engineer (Junior) Philippines. We're so happy that you're interested in Burt Intelligence!",
    }),
    want: { application_key: "burt intelligence|solutions engineer (junior) philippines" },
  },
  // From the first live backfill batch over 2025 mail: each made a junk or
  // duplicate Feed row.
  {
    name: "JobStreet confirmation with the company wrapped onto the next line",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@jobstreet.com", name: "Jobstreet Applications" }] },
      text: "Hi Joshua Klyne, your application for Javascript Developer was successfully\nsubmitted to Digital Room (Philippines) , Inc.\n%%str_to_replace_open_tracking%%\n\nHi Joshua Klyne,\nYour application for Javascript Developer was successfully submitted to Digital\nRoom (Philippines) , Inc.. Each hirer has their own recruitment process.",
    }),
    want: { application_key: "digital room (philippines) , inc.|javascript developer" },
  },
  {
    name: "JobStreet 'advertised by <C> is unlikely to progress'",
    input: email({
      subject: "Application update for Python Developer (WFH) at ACCION LABS PHILIPPINES, INC.",
      from: { value: [{ address: "noreply@e.jobstreet.com", name: "Jobstreet Applications" }] },
      text: "Hi Joshua Klyne, it appears your application for Python Developer (WFH)\nadvertised by ACCION LABS PHILIPPINES, INC. is unlikely to progress further\n%%str_to_replace_open_tracking%%\n\nHi Joshua Klyne,\nThank you for your interest in the Python Developer (WFH) job at ACCION LABS\nPHILIPPINES, INC.. Unfortunately, it looks unlikely that your application will\nprogress further.",
    }),
    want: { status: "rejected", application_key: "accion labs philippines, inc.|python developer (wfh)" },
  },
  {
    name: "SEEK confirmation names the employer, not SEEK",
    input: email({
      subject: "Your application was successfully submitted",
      from: { value: [{ address: "noreply@s.seek.com.au", name: "SEEK Applications" }] },
      text: "Hi Joshua Klyne, your application for Junior Full Stack Developer was\nsuccessfully submitted to ProSpend Pty Ltd\n%%str_to_replace_open_tracking%%\n\nHi Joshua Klyne,\nYour application for Junior Full Stack Developer was successfully submitted to\nProSpend Pty Ltd.\nEach employer's recruitment process is different.",
    }),
    want: { application_key: "prospend pty ltd|junior full stack developer" },
  },
  {
    name: "'for our <T> role' drops the 'our'",
    input: email({
      subject: "Thank you for your application",
      from: { value: [{ address: "771ce723@pinpoint.email", name: "Zencargo" }] },
      text: "Hi JOSHUA,\n\nThank you for applying for our Junior Data Analyst (12 Month Fixed Term) role at Zencargo.\n\nWe are delighted that you are interested in joining Zencargo.",
    }),
    want: { application_key: "zencargo|junior data analyst (12 month fixed term)" },
  },
  {
    name: "'position here at <C>' and a '|' inside the title",
    input: email({
      subject: "Project Manager (Early Career | Open to Fresh Grads) Application Confirmation",
      from: { value: [{ address: "cd5600bc@pinpoint.email", name: "Spiralyze" }] },
      text: "Hi Joshua Klyne,\n\nThank you so much for applying to the Project Manager (Early Career | Open to Fresh Grads) position here at Spiralyze! We are looking forward to reviewing your application!",
    }),
    want: { application_key: "spiralyze|project manager (early career|open to fresh grads)" },
  },
  {
    name: "company stops at 'and', not at the end of the sentence",
    input: email({
      subject: "Update on Your Application for the Backend Software Developer Position",
      from: { value: [{ address: "careers@sozoroad.com", name: "Sozoroad Careers" }] },
      text: "Dear Joshua Klyne Pudadera,\nThank you for taking the time to apply for the Backend Software Developer position at Sozoroad and for the time and effort you put into your application.\nAfter careful consideration, we have decided to move forward with other candidates.",
    }),
    want: { application_key: "sozoroad|backend software developer" },
  },
  {
    name: "'and' inside a company name is kept",
    input: email({
      subject: "An update on your application from Training and Marketing Professionals Inc.",
      from: { value: [{ address: "noreply@indeed.com", name: "Training and Marketing Professionals Inc." }] },
      text: "Thank you for applying to the Data Science and AI Engineer position at Training\nand Marketing Professionals Inc.. Unfortunately, Training and Marketing\nProfessionals Inc. has moved to the next step in their hiring process, and your\napplication was not selected at this time.",
    }),
    want: { company: "Training and Marketing Professionals Inc." },
  },
  {
    name: "company stops at a sentence with no space after the period",
    input: email({
      subject: "Application Received - Thank You!",
      from: { value: [{ address: "info@recooty.com", name: "Welo Data" }] },
      text: "Dear Joshua,Thank you for applying for the Prompt Optimization Tagalog (Philippines) position at Welo Data.We have received your application, and our hiring team is currently reviewing all submissions.",
    }),
    want: { application_key: "welo data|prompt optimization tagalog (philippines)" },
  },
  {
    name: "emoji in the company name is dropped",
    input: email({
      subject: "Wild Card - Hugging Face",
      from: { value: [{ address: "noreply@candidates.workablemail.com", name: "Hugging Face" }] },
      text: "Hi Joshua, \n\nThank you for applying to the Wild Card opportunity at Hugging Face 🤗 . \n\nWe do hiring in a very decentralized way here at Hugging Face.",
    }),
    want: { application_key: "hugging face|wild card" },
  },
  {
    // The sending host is a subdomain; the employer is the domain under it.
    name: "subdomain sender names the domain's company",
    input: email({
      subject: "Update on your application",
      from: { value: [{ address: "updates@notify.mindrift.ai", name: "" }] },
      text: "Dear Joshua Klyne Pudadera,\n\nThank you for your interest in the English role. Regrettably, we will not be \nmoving forward with your application at this time.",
    }),
    want: { status: "rejected", application_key: "mindrift|english" },
  },
  {
    name: "Ashby-style interview mail with a wrapped title",
    input: email({
      subject: "Your Application for Graduate Programme - Philippines (Remote)",
      from: { value: [{ address: "samridhi.sharma@pricelabs.co", name: "Samridhi Sharma" }] },
      text: "Hi Joshua,\n\nThank you for taking the time to interview for the Graduate Programme -\nPhilippines (Remote) role at PriceLabs. We sincerely appreciate your interest in\nour team.\n\nAfter careful consideration, we’ve decided not to move forward with your\napplication at this time. Unfortunately, we were unable to find a perfect\nalignment.",
    }),
    want: { status: "rejected", application_key: "pricelabs|graduate programme - philippines (remote)" },
  },
  {
    name: "Emapta update: 'at EMAPTA' is not part of the title",
    input: email({
      subject: "Update on Your Application for Analytics Engineer (Marketing Analytics) at EMAPTA",
      from: { value: [{ address: "careers@emapta.com", name: "" }] },
      text: "Update on Your Application for Analytics Engineer (Marketing Analytics) at\nEMAPTA\n\nDear Joshua Klyne Pudadera,\n\nWe wanted to provide you with an update on the status of the Analytics Engineer\n(Marketing Analytics) vacancy. With your resume remaining under consideration, we will revisit your profile.",
    }),
    want: { job_title: "Analytics Engineer (Marketing Analytics)" },
  },
  {
    name: "Teamtailor 'complete the application for <T>'",
    input: email({
      subject: "Complete the application for Junior AI Data Analyst",
      from: { value: [{ address: "no-reply@isentia.teamtailor-mail.com", name: "Isentia" }] },
      text: "Verify your email to complete the application for Junior AI Data Analyst\n\nVisit the URL below to complete the application.\n\n- Isentia",
    }),
    want: { job_title: "Junior AI Data Analyst" },
  },
  {
    name: "Workday sender: the tenant is the employer",
    input: email({
      subject: "We’ve Received Your Application for Professional Services Software Engineer",
      from: { value: [{ address: "8x8inc@myworkday.com", name: "" }] },
      text: "",
    }),
    want: { company: "8x8" },
  },
  {
    name: "Wellfound: employer from the subject, job from the listing",
    input: email({
      subject: "Application to Scale AI successfully submitted",
      from: { value: [{ address: "team@hi.wellfound.com", name: "Wellfound (formerly AngelList Talent)" }] },
      text: "Your application has been submitted! \n\n If there's a match, we will make an email introduction. \n\n * AI Writing Evaluator and Trainer \n<https://wellfound.com/jobs/1>\n *  Scale AI · Remote \n",
    }),
    want: { application_key: "scale ai|ai writing evaluator and trainer" },
  },
  {
    name: "'Next Steps for the <T> position' subject",
    input: email({
      subject: "Application Status and Next Steps for the UI/UX Designer position",
      from: { value: [{ address: "noreply@applytojob.com", name: "Codekeeper" }] },
      text: "Hi Joshua Klyne,\n\nThank you for applying to Codekeeper. We have received your application.",
    }),
    want: { application_key: "codekeeper|ui/ux designer" },
  },
  {
    // None of these name a job: a greeting, punctuation, the company's own
    // name, a bootcamp deadline. Each became a Feed row.
    name: "greeting left after the lead-in is no title",
    input: email({ subject: "Thank you for your application, Joshua Klyne",
      from: { value: [{ address: "erp.hr@adp.com", name: "" }] }, text: "" }),
    want: { job_title: "", parsed: false },
  },
  {
    name: "title that is the start of the company name is no title",
    input: email({ subject: "Thank you for applying to Robert Bosch (SEA) Pte Ltd",
      from: { value: [{ address: "notification@smartrecruiters.com", name: "Bosch Group" }] },
      text: "Thank you for your application. Your online application was successfully received." }),
    want: { job_title: "", parsed: false },
  },
  {
    name: "deadline subject is no title",
    input: email({ subject: "You have 72 hours to complete The AI Engineer Challenge!",
      from: { value: [{ address: "chris@aimakerspace.io", name: "AI Makerspace" }] },
      text: "Thanks for applying to *The AI Engineering Bootcamp*!" }),
    want: { job_title: "", parsed: false },
  },
  {
    name: "a title with no letters is no title",
    input: email({ subject: "Thank you for applying!",
      from: { value: [{ address: "talent@remotely.works", name: "Remotely.Works" }] },
      text: "<html><head><title>Thank you for applying!</title></head></html>" }),
    want: { job_title: "", parsed: false },
  },
  {
    name: "date is normalised to ISO",
    input: email({ subject: "Thank you for applying to Portcast", date: "2026-08-03T22:45:10.000Z",
      from: { value: [{ address: "hr@portcast.io", name: "Portcast" }] } }),
    want: { received_at: "2026-08-03" },
  },
  {
    name: "epoch-millisecond internalDate is handled",
    input: email({ subject: "Thank you for applying to Portcast", date: undefined,
      internalDate: 1754260000000,
      from: { value: [{ address: "hr@portcast.io", name: "Portcast" }] } }),
    want: { received_at: "2025-08-03" },
  },
  {
    name: "raw_text carries subject and body for the LLM fallback",
    input: email({ subject: "Application Update", text: "We wanted to give you an update." }),
    want: { raw_text: "Application Update\n\nWe wanted to give you an update." },
  },
];

console.log("Parser tests\n");
for (const c of cases) {
  const got = parse(c.input).json;
  for (const [field, want] of Object.entries(c.want)) {
    expect(`${c.name} → ${field}`, got[field], want);
  }
}

// Everything parsed goes to Feed, keyed on application_key. A parsed row with
// an empty part or stray spaces around "|" would make a Feed row no later
// email can match — that is how duplicates start.
console.log("\nFeed key invariant");
for (const c of cases) {
  const got = parse(c.input).json;
  if (!got.parsed) continue;
  const parts = got.application_key.split("|");
  expect(`${c.name} → well-formed application_key`,
    Boolean(got.company) && parts.length >= 2 && parts.every((p) => p !== "" && p === p.trim()), true);
}

// The parser must never throw, whatever Gmail hands it. A missing field is a
// needs-review row, not a failed execution that strands the email unlabelled.
console.log("\nRobustness");
for (const junk of [{}, { subject: null }, { from: {} }, { date: "not a date" }, { text: 12345 }]) {
  let threw = null;
  let out = null;
  try { out = parse({ id: "x", ...junk }).json; } catch (e) { threw = e; }
  expect(`survives ${JSON.stringify(junk)}`, threw === null && typeof out === "object", true);
}

const longBody = "x".repeat(10000);
const truncated = parse(email({ subject: "Long email", text: longBody })).json.raw_text;
expect("raw_text is bounded to 4000 chars", truncated.length <= 4000, true);

console.log(failures ? `\n${failures} check(s) failed\n` : "\nAll parser checks passed\n");
process.exit(failures ? 1 : 0);
