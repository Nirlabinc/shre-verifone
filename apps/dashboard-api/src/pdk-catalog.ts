export interface PdkCommand {
  id: string;
  cmd: string;
  category: string;
  params: string[];
  mutating: boolean;
  description: string;
  deprecated?: boolean;
  reportType?: string;
  defaults?: Record<string, string>;
}

const maintenanceCommands = [
  "vecheckcfg", "uecheckcfg", "vdcrunattendedcfg", "udcrunattendedcfg", "umanagedcfg", "vmanagedcfgstatus",
  "vscreencfg", "uscreencfg", "vinhousecfg", "uinhousecfg", "vuseradmin", "uuseradmin", "vsapphireprop",
  "usapphireprop", "vfuelcfg", "ufuelcfg", "vfuelrtcfg", "vfuelrtpricescfg", "vpscdcrcfg", "upscdcrcfg",
  "vexpandeddealcfg", "uexpandeddealcfg", "vfepdetails", "vvipercfg", "uvipercfg", "vfepcfg", "ufepcfg",
  "vfepcardcfg", "ufepcardcfg", "vfepcardtypecfg", "ufepcardtypecfg", "vdealcfg", "udealcfg",
  "vregistercfg", "uregistercfg", "vpaymentcfg", "upaymentcfg", "vposcfg", "uposcfg", "vfuelsite",
  "ufuelsite", "vrestrictionscfg", "urestrictionscfg", "vpossecurity", "upossecurity", "vdcrcfg",
  "udcrcfg", "vrefinteg", "vsalescfg", "usalescfg", "vpopcfg", "upopcfg", "vtlssite", "utlssite",
  "vcarwashcfg", "ucarwashcfg", "vcashaccsite", "ucashaccsite", "vagevalidationcfg", "uagevalidationcfg",
  "vbannercfg", "ubannercfg", "vbluelawcfg", "ubluelawcfg", "vdcrheadercfg", "udcrheadercfg",
  "vdcrmessagecfg", "udcrmessagecfg", "vdcrtrailercfg", "udcrtrailercfg", "vfeecfg", "ufeecfg",
  "vlogocfg", "ulogocfg", "vslogancfg", "uslogancfg", "vtaxratecfg", "utaxratecfg", "vdatetime",
  "udatetime", "vperiodcfg", "uperiodcfg", "vmaintcfg", "umaintcfg", "vPLUs", "uPLUs", "changepasswd",
  "vesafecfg", "uesafecfg", "vcwpaypointcfg", "ucwpaypointcfg", "vloyaltycfg", "uloyaltycfg",
  "vFPDcfg", "uFPDcfg", "vfuelprices", "ufuelprices", "cfuelinit", "cfuelprices", "cdcrinit",
  "cFPDinit", "vsigcapcfg", "usigcapcfg",
];

const availabilityCommands = ["vtlogpdlist", "vcashierpdlist", "vpayrollpdlist2", "vcwpaypointpdlist", "vreportpdlist", "vviperpdList"];
const databaseReportNames = [
  "summary", "department", "eCheck", "tax", "hourly", "network", "deal", "plu", "category", "cashAcc",
  "carWash", "propCard", "propProd", "moneyOrderDev", "networkTotals", "cwPaypoint", "esafeeod",
  "esafecontent",
];
const fuelReportNames = [
  "popDisc", "dcrStat", "fpHoseTest", "fpHose", "fpHoseRunning", "prPriceLvl", "slPriceLvl",
  "tierProduct", "autoCollect", "tank", "tankMonitor", "tankRec", "blendProduct", "fpDispenser",
  "popDef", "popdiscprgmrpt",
];
const transactionReportCommands = ["vperiodrept", "vperiodreptz", "vperiodrept2", "vtransset", "vtranssetz"];
const viperReportNames = ["batchTotals", "loyaltyTotals", "paymentTotals", "prepaidTotals"];
const deprecatedCommands = ["vnetcfg", "unetcfg", "vfuelposstat", "vPLUCacheList", "uPLUCacheList", "vPLUUpdateStatus", "getPLUsFromGempro", "sendPLUsToGempro", "vpayrollpdlist"];

function isMutatingCommand(cmd: string): boolean {
  return cmd.startsWith("u") || cmd.startsWith("c") || cmd === "changepasswd" || cmd.startsWith("send");
}

function command(id: string, cmd: string, category: string, params: string[], description: string, extra: Partial<PdkCommand> = {}): PdkCommand {
  return {
    id,
    cmd,
    category,
    params,
    mutating: isMutatingCommand(cmd),
    description,
    ...extra,
  };
}

function rubyReport(name: string, category: string, reportType: string): PdkCommand[] {
  return [
    command(`vrubyrept.${name}.filename`, "vrubyrept", category, ["period", "filename"], `View ${name} report by period and filename.`, {
      reportType,
      defaults: { reptname: name },
    }),
    command(`vrubyrept.${name}.reptnum`, "vrubyrept", category, ["period", "reptnum"], `View ${name} report by period and report number.`, {
      reportType,
      defaults: { reptname: name },
    }),
  ];
}

export const pdkCommandCatalog: PdkCommand[] = [
  command("vAppInfo", "vAppInfo", "information", [], "View Commander application information."),
  command("validate", "validate", "credential", ["user", "passwd"], "Validate credentials and return session cookie.", { mutating: false }),
  command("cenablelogin", "cenablelogin", "credential", [], "Enable OTP/login flow using current cookie.", { mutating: true }),
  ...availabilityCommands.map((cmd) => command(cmd, cmd, "report-availability", [], `Retrieve ${cmd} availability list.`)),
  command("vcashierrept", "vcashierrept", "reports-database", ["filename", "cashierNum", "regNum"], "View cashier report by filename, cashier, and register.", { reportType: "sales" }),
  command("vesafecashierrept", "vesafecashierrept", "reports-database", ["filename", "cashierNum", "regNum"], "View electronic safe cashier report.", { reportType: "safe" }),
  ...databaseReportNames.flatMap((name) => rubyReport(name, "reports-database", ["department", "plu", "category", "summary", "hourly"].includes(name) ? "sales" : name)),
  ...fuelReportNames.flatMap((name) => rubyReport(name, "reports-fuel", ["tank", "tankMonitor", "tankRec"].includes(name) ? "tank" : "fuel")),
  ...transactionReportCommands.flatMap((cmd) => [
    command(`${cmd}.filename`, cmd, "reports-transaction-log", ["period", "filename"], `View ${cmd} by period and filename.`, { reportType: "sales" }),
    command(`${cmd}.reptnum`, cmd, "reports-transaction-log", ["period", "reptnum"], `View ${cmd} by period and report number.`, { reportType: "sales" }),
  ]),
  command("vfueltotals.filename", "vfueltotals", "reports-fuel", ["period", "filename"], "View fuel totals by filename.", { reportType: "fuel" }),
  command("vfueltotals.reptnum", "vfueltotals", "reports-fuel", ["period", "reptnum"], "View fuel totals by report number.", { reportType: "fuel" }),
  command("vfueltotalsz.filename", "vfueltotalsz", "reports-fuel", ["period", "filename"], "View fuel totals Z by filename.", { reportType: "fuel" }),
  command("vfueltotalsz.reptnum", "vfueltotalsz", "reports-fuel", ["period", "reptnum"], "View fuel totals Z by report number.", { reportType: "fuel" }),
  command("vcwpaypointpdrept", "vcwpaypointpdrept", "reports-carwash", ["filename"], "View car wash pay point period report.", { reportType: "carwash" }),
  command("vmobilereportcategorylist", "vmobilereportcategorylist", "reports-mobile", [], "View mobile report categories."),
  command("vmobilehostlist", "vmobilehostlist", "reports-mobile", [], "View mobile host list."),
  command("vmobilereportlist", "vmobilereportlist", "reports-mobile", ["hostName"], "View reports available for mobile host."),
  command("vmobilereport", "vmobilereport", "reports-mobile", ["hostName", "reportName", "filename"], "View mobile report."),
  ...viperReportNames.map((name) => command(`vviperrept.${name}`, "vviperrept", "reports-viper", ["fepname", "terminalbatchnum"], `View VIPER ${name} report.`, {
    reportType: name.includes("batch") ? "batch" : "payment",
    defaults: { reptname: name },
  })),
  ...maintenanceCommands.map((cmd) => command(cmd, cmd, "maintenance", [], `${cmd} maintenance/configuration command.`)),
  command("repeatEvent", "repeatEvent", "event-notification", [], "Repeat event notification."),
  command("veventcfg", "veventcfg", "event-notification", [], "View event configuration."),
  command("ueventcfg", "ueventcfg", "event-notification", [], "Update event configuration."),
  command("vsetevent", "vsetevent", "event-notification", ["x", "y", "z"], "Set event notification."),
  command("veventhistory", "veventhistory", "event-notification", [], "View event history."),
  command("veventunset", "veventunset", "event-notification", [], "Unset event notification."),
  ...deprecatedCommands.map((cmd) => command(cmd, cmd, "deprecated", [], `${cmd} deprecated PDK command.`, { deprecated: true })),
];

export function pdkCommandById(id: string): PdkCommand | undefined {
  return pdkCommandCatalog.find((item) => item.id === id || item.cmd === id);
}
