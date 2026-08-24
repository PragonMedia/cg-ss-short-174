// Helper function to preserve all original URL parameters when modifying URL
// This ensures tracking parameters (bbg_*, mb, account, angle, key, channel, etc.) are never lost
function preserveUrlParams(url) {
  // Restore original parameters from sessionStorage
  const storedParams = sessionStorage.getItem("original_url_params");
  if (storedParams) {
    try {
      const originalParams = JSON.parse(storedParams);
      // Add all original parameters that aren't already in the URL
      // This preserves tracking parameters that might have been lost
      for (const [k, v] of Object.entries(originalParams)) {
        if (!url.searchParams.has(k) && v != null && v !== "") {
          url.searchParams.set(k, v);
        }
      }
    } catch (e) {
      console.error("Error preserving original params:", e);
    }
  }
  return url;
}

const CALLGRID_NUMBER_TIMEOUT_MS = 2000;
const DOMAIN_ROUTE_API = "/api/v1/domain-route-details";

function getDomainAndRoute() {
  const url = new URL(window.location.href);
  // Match BE / PHP: hostname without www.
  const domain = url.hostname.replace(/^www\./, "");
  const pathSegments = url.pathname
    .split("/")
    .filter((segment) => segment && !segment.includes("."));
  const route = pathSegments[0] || "";
  return { domain, route };
}

function normalizePhoneDigits(phoneNumber) {
  return String(phoneNumber || "").replace(/\D/g, "");
}

function getRequiredCallgridFields(routeData) {
  if (!routeData || typeof routeData !== "object") return null;
  const organizationId = routeData.callgridOrganizationId;
  const campaignId = routeData.callgridCampaignId;
  const campaignSourceId = routeData.callgridCampaignSourceId;
  const phoneNumber = normalizePhoneDigits(routeData.phoneNumber);
  if (!organizationId || !campaignId || !campaignSourceId || phoneNumber.length < 10) {
    return null;
  }
  return {
    organizationId: String(organizationId),
    campaignId: String(campaignId),
    campaignSourceId: String(campaignSourceId),
    phoneNumber,
    mediaBuyerName: routeData.callgridMediaBuyerName || "",
    rtkID: routeData.rtkID || null,
  };
}

function showTrackingConfigError(message) {
  window.callgridConfigOk = false;
  const el = document.getElementById("tracking-config-error");
  if (el) {
    el.textContent =
      message ||
      "Call tracking is not configured for this page. Please try again later.";
    el.classList.remove("hidden");
    el.style.display = "block";
  }
  const link = document.getElementById("phone-number");
  if (link) {
    link.href = "javascript:void(0)";
    link.style.pointerEvents = "none";
    link.setAttribute("aria-disabled", "true");
  }
  console.error("CallGrid config error:", message);
}

function hideTrackingConfigError() {
  const el = document.getElementById("tracking-config-error");
  if (el) {
    el.classList.add("hidden");
    el.style.display = "none";
  }
}

async function fetchDomainRouteDetails() {
  const { domain, route } = getDomainAndRoute();
  if (!domain) {
    return { ok: false, error: "Missing domain for route lookup" };
  }

  let apiUrl =
    DOMAIN_ROUTE_API + "?domain=" + encodeURIComponent(domain);
  if (route) {
    apiUrl += "&route=" + encodeURIComponent(route);
  }

  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!response.ok) {
      return {
        ok: false,
        error: "domain-route-details HTTP " + response.status,
      };
    }
    const data = await response.json();
    if (!data || data.success !== true || !data.routeData) {
      return { ok: false, error: "domain-route-details success=false" };
    }

    const callgrid = getRequiredCallgridFields(data.routeData);
    if (!callgrid) {
      return {
        ok: false,
        error:
          "Missing callgridOrganizationId, callgridCampaignId, callgridCampaignSourceId, or phoneNumber",
        data,
      };
    }

    return {
      ok: true,
      data,
      callgrid,
      domainContext: data.domainContext || {},
    };
  } catch (error) {
    console.error("Error fetching domain-route-details:", error);
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

// Page-load fetch: stash config for CallGrid + clickid. No hardcoded IDs.
// May already be started from index.html (before clickid mint).
if (!window.domainRoutePromise) {
  window.domainRoutePromise = (async function initDomainRouteData() {
    const result = await fetchDomainRouteDetails();
    window.domainRouteResult = result;

    if (!result.ok) {
      showTrackingConfigError(
        "Tracking unavailable for this page. Route is missing CallGrid configuration.",
      );
      window.domainRouteData = null;
      window.callgridConfig = null;
      window.callgridConfigOk = false;
      return result;
    }

    hideTrackingConfigError();
    window.callgridConfigOk = true;
    window.domainRouteData = result.data;
    window.callgridConfig = result.callgrid;
    window.domainContext = result.domainContext;

    applyPhoneToDom(result.callgrid.phoneNumber);
    console.log("CallGrid config from API:", {
      organizationId: result.callgrid.organizationId,
      campaignId: result.callgrid.campaignId,
      campaignSourceId: result.callgrid.campaignSourceId,
      phoneNumber: result.callgrid.phoneNumber,
      mediaBuyerName: result.callgrid.mediaBuyerName,
    });
    return result;
  })();
} else {
  window.domainRoutePromise.then(function (result) {
    if (result && result.ok && result.callgrid) {
      applyPhoneToDom(result.callgrid.phoneNumber);
    } else if (result && !result.ok) {
      showTrackingConfigError(
        "Tracking unavailable for this page. Route is missing CallGrid configuration.",
      );
    }
  });
}

// Show loader on phone button while CallGrid assigns a tracking number
function setPhoneButtonLoading(loading) {
  const link = document.getElementById("phone-number");
  const textEl = document.getElementById("phone_retreaver");
  if (!link || !textEl) return;
  if (loading) {
    link.classList.add("phone-number-loading");
    link.href = "javascript:void(0)";
    link.style.pointerEvents = "none";
    textEl.textContent = "Loading...";
  } else {
    link.classList.remove("phone-number-loading");
    link.style.pointerEvents = "";
  }
}

function formatPhoneDisplay(phoneNumber) {
  const raw = String(phoneNumber).replace(/\D/g, "");
  if (raw.length >= 11) {
    return (
      "+1 (" +
      raw.slice(1, 4) +
      ") " +
      raw.slice(4, 7) +
      "-" +
      raw.slice(7, 11)
    );
  }
  if (raw.length === 10) {
    return (
      "+1 (" +
      raw.slice(0, 3) +
      ") " +
      raw.slice(3, 6) +
      "-" +
      raw.slice(6, 10)
    );
  }
  return raw;
}

function applyPhoneToDom(phoneNumber) {
  if (!window.updatePhoneNumberInDOM) return;
  const digits = String(phoneNumber).replace(/\D/g, "");
  const formatted = formatPhoneDisplay(digits);
  window.updatePhoneNumberInDOM(digits, formatted);
  window.phoneNumberData = {
    phone_number: digits,
    formatted_number: formatted,
  };
}

function buildCallGridTags() {
  const params = new URL(window.location.href).searchParams;
  const tags = {
    type: "RT",
    track_attempted: "yes",
    qualified: params.get("qualified") || "unknown",
    age: params.get("age") || "unknown",
  };

  const gtgValue = localStorage.getItem("gtg");
  if (gtgValue !== null && gtgValue !== undefined && gtgValue !== "") {
    tags.gtg = gtgValue;
  }

  const clickid =
    (window.testData && window.testData.rtkcid) ||
    localStorage.getItem("rt_clickid") ||
    params.get("clickid");
  if (clickid) {
    tags.clickid = clickid;
    tags.rtkcid = clickid;
  }

  const mb = params.get("mb");
  if (mb) tags.mb = mb;

  if (window.callgridConfig && window.callgridConfig.mediaBuyerName) {
    tags.mediaBuyerName = window.callgridConfig.mediaBuyerName;
  }

  return tags;
}

function watchCallGridClickidTags(callgrid) {
  if (!callgrid || typeof callgrid.addTags !== "function") return;

  var intervalId = setInterval(() => {
    if (window.testData && window.testData.rtkcid !== undefined) {
      const tags = {
        clickid: window.testData.rtkcid,
        rtkcid: window.testData.rtkcid,
        qualified:
          new URL(window.location.href).searchParams.get("qualified") ||
          "unknown",
        age:
          new URL(window.location.href).searchParams.get("age") || "unknown",
      };
      const gtgValue = localStorage.getItem("gtg");
      if (gtgValue) tags.gtg = gtgValue;
      const mb = new URL(window.location.href).searchParams.get("mb");
      if (mb) tags.mb = mb;

      callgrid.addTags(tags);
      console.log("Sending click tags to CallGrid:", tags);
      clearInterval(intervalId);
    }
  }, 500);
}

async function ensureCallgridConfig() {
  if (window.callgridConfig && window.callgridConfigOk) {
    return window.callgridConfig;
  }
  const result = await (window.domainRoutePromise || fetchDomainRouteDetails());
  if (!result || !result.ok || !result.callgrid) {
    showTrackingConfigError(
      "Tracking unavailable for this page. Route is missing CallGrid configuration.",
    );
    return null;
  }
  window.callgridConfigOk = true;
  window.callgridConfig = result.callgrid;
  window.domainRouteData = result.data;
  window.domainContext = result.domainContext;
  return result.callgrid;
}

// Load CallGrid CDN once and initialize from API routeData (no hardcodes)
function loadCallGrid(config) {
  return new Promise((resolve, reject) => {
    if (!config) {
      reject(new Error("CallGrid config missing"));
      return;
    }

    if (window.callgridInstance) {
      resolve(window.callgridInstance);
      return;
    }

    const initInstance = () => {
      if (window.callgridInstance) {
        resolve(window.callgridInstance);
        return;
      }
      window.callgridInstance = new CallGrid({
        organizationId: config.organizationId,
        campaignSourceId: config.campaignSourceId,
        autoEnableDNI: true,
        targetPhoneNumber: config.phoneNumber,
        tags: buildCallGridTags(),
      });
      console.log("CallGrid initialized:", {
        organizationId: config.organizationId,
        campaignId: config.campaignId,
        campaignSourceId: config.campaignSourceId,
        targetPhoneNumber: config.phoneNumber,
        tags: buildCallGridTags(),
      });
      watchCallGridClickidTags(window.callgridInstance);
      resolve(window.callgridInstance);
    };

    if (window.CallGrid) {
      initInstance();
      return;
    }

    const existing = document.querySelector(
      'script[src*="cdn.callgrid.com/callgrid.js"]',
    );
    if (existing) {
      existing.addEventListener("load", initInstance);
      existing.addEventListener("error", () =>
        reject(new Error("CallGrid script failed to load")),
      );
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.callgrid.com/callgrid.js";
    script.async = true;
    script.onload = initInstance;
    script.onerror = () => reject(new Error("CallGrid script failed to load"));
    document.head.appendChild(script);
  });
}

// Wait for CallGrid number assignment, fall back to API phoneNumber after timeout
function assignCallGridNumber(config) {
  return new Promise((resolve, reject) => {
    if (!config) {
      reject(new Error("CallGrid config missing"));
      return;
    }

    let settled = false;
    const fallbackPhone = config.phoneNumber;

    const finish = (phoneNumber) => {
      if (settled) return;
      settled = true;
      applyPhoneToDom(phoneNumber);
      setPhoneButtonLoading(false);
      resolve(phoneNumber);
    };

    const fallbackTimer = setTimeout(() => {
      console.log(
        "CallGrid timeout — using API phoneNumber:",
        fallbackPhone,
      );
      finish(fallbackPhone);
    }, CALLGRID_NUMBER_TIMEOUT_MS);

    const onAssigned = (event) => {
      document.removeEventListener("callgrid:numberAssigned", onAssigned);
      clearTimeout(fallbackTimer);
      const assigned =
        (event.detail && event.detail.phoneNumber) || fallbackPhone;
      console.log("CallGrid number assigned:", assigned);
      finish(assigned);
    };

    document.addEventListener("callgrid:numberAssigned", onAssigned);

    loadCallGrid(config)
      .then((callgrid) => {
        if (
          settled ||
          !callgrid ||
          typeof callgrid.getAssignedNumber !== "function"
        ) {
          return;
        }
        const already = callgrid.getAssignedNumber();
        if (already) {
          document.removeEventListener("callgrid:numberAssigned", onAssigned);
          clearTimeout(fallbackTimer);
          finish(already);
        }
      })
      .catch((error) => {
        console.error("CallGrid load error:", error);
        document.removeEventListener("callgrid:numberAssigned", onAssigned);
        clearTimeout(fallbackTimer);
        finish(fallbackPhone);
      });
  });
}

// Reactive phone number update - called ONLY when showing the phone step (qualified users).
async function updatePhoneNumberReactive() {
  if (!window.updatePhoneNumberInDOM) return;

  const link = document.getElementById("phone-number");
  const textEl = document.getElementById("phone_retreaver");
  if (!link || !textEl) return;

  setPhoneButtonLoading(true);

  try {
    const config = await ensureCallgridConfig();
    if (!config) {
      textEl.textContent = "Unavailable";
      setPhoneButtonLoading(false);
      return;
    }
    await assignCallGridNumber(config);
  } catch (error) {
    console.error("Error assigning CallGrid number (qualified step):", error);
    showTrackingConfigError(
      "Unable to load call tracking. Please try again later.",
    );
    setPhoneButtonLoading(false);
  }
}

function startCountdown() {
  var timeLeft = 30;
  var countdownElement = document.getElementById("countdown");
  var countdownInterval = setInterval(function () {
    var minutes = Math.floor(timeLeft / 60);
    var seconds = timeLeft % 60;
    var formattedTime =
      (minutes < 10 ? "0" : "") +
      minutes +
      ":" +
      (seconds < 10 ? "0" : "") +
      seconds;
    countdownElement.innerHTML = formattedTime;
    if (timeLeft <= 0) {
      clearInterval(countdownInterval);
    }
    timeLeft--;
  }, 1000);
}

function loadImages() {
  let images = document.querySelectorAll(".lazyloading");
  images.forEach((image) => {
    if (image.dataset.src) {
      image.src = image.dataset.src;
    }
  });
}

let speed = 750;

function updateAgeGroup(ageGroup) {
  let url = new URL(window.location.href);
  // Preserve all original parameters first
  url = preserveUrlParams(url);
  url.searchParams.delete("u65consumer");
  url.searchParams.delete("o65consumer");
  if (ageGroup === "under65") {
    url.searchParams.set("u65consumer", "true");
  } else if (ageGroup === "over65") {
    url.searchParams.set("o65consumer", "true");
  }
  window.history.replaceState({}, "", url);
}

let is_below = false;
let is_between = false;
let is_71plus = false;

loadImages();

// Initial chat sequence: msg1 -> msg2 -> msg3 -> msg4 -> age buttons
function runInitialSequence() {
  $("#initTyping").remove();
  $("#msg1").removeClass("hidden").after(typingEffect());
  setTimeout(function () {
    $(".temp-typing").remove();
    $("#msg2").removeClass("hidden").after(typingEffect());
    scrollToBottom();
    setTimeout(function () {
      $(".temp-typing").remove();
      $("#msg3").removeClass("hidden").after(typingEffect());
      scrollToBottom();
      setTimeout(function () {
        $(".temp-typing").remove();
        $("#msg4").removeClass("hidden");
        scrollToBottom();
        setTimeout(function () {
          $("#msg_age_buttons").removeClass("hidden");
          scrollToBottom();
        }, speed);
      }, speed);
    }, speed);
  }, speed);
}
setTimeout(runInitialSequence, speed);

var buttonValue;
var currentStep;

$("button.chat-button").on("click", function () {
  currentStep = $(this).attr("data-form-step");
  buttonValue = $(this).attr("data-form-value");

  if (currentStep == 2) {
    $("#msg_age_buttons").addClass("hidden");
    $("#userBlock_q2").removeClass("hidden");

    var newUrl = new URL(window.location.href); // Define the URL once
    // Preserve all original parameters first
    newUrl = preserveUrlParams(newUrl);

    if (buttonValue == "below 65") {
      $("#msg_under_q2").removeClass("hidden");
      $("#hdnApprovalStatus").val("no");

      newUrl.searchParams.delete("age");
      newUrl.searchParams.set("age", "65");

      updateAgeGroup("under65");
      is_below = true;
    } else if (buttonValue == "65 - 70") {
      $("#msg_over_q2").removeClass("hidden");
      $("#hdnApprovalStatus").val("no");

      newUrl.searchParams.delete("age");
      newUrl.searchParams.set("age", "70");

      updateAgeGroup("over65");
      is_between = true;
    } else if (buttonValue == "71 - 75") {
      $("#msg_over71_q2").removeClass("hidden");

      newUrl.searchParams.delete("age");
      newUrl.searchParams.set("age", "75");

      is_71plus = true;
    } else if (buttonValue == "76 and older") {
      $("#msg_76older_q2").removeClass("hidden");

      newUrl.searchParams.delete("age");
      newUrl.searchParams.set("age", "80");

      is_71plus = true;
    }

    // Update the URL with the new age parameter
    window.history.replaceState({}, "", newUrl);

    $("#agentBlock_q3").removeClass("hidden");
    $("#agentBlock_q3 .agent-chat").prepend(typingEffect());

    scrollToBottom();
    setTimeout(function () {
      $(".temp-typing").remove();
      $("#msg_q3_1").removeClass("hidden").after(typingEffect());
      scrollToBottom();
      setTimeout(function () {
        $(".temp-typing").remove();
        $("#msg_q3_2").removeClass("hidden");
        scrollToBottom();
      }, speed);
    }, speed);
  }

  if (currentStep == 4) {
    $("#msg_insurance_2").addClass("hidden");
    $("#userBlock_insurance").removeClass("hidden");
    if (buttonValue == "Yes") {
      $("#msg_yes_insurance").removeClass("hidden");
      scrollToBottom();
      setTimeout(function () {
        $("#agentBlock4").removeClass("hidden");
        scrollToBottom();
        setTimeout(function () {
          $(".temp-typing").remove();
          $("#msg18").removeClass("hidden").after(typingEffect());
          scrollToBottom();
          setTimeout(function () {
            $(".temp-typing").remove();
            $("#disconnected").removeClass("hidden");
          }, speed);
        }, speed);
      }, speed);
      return;
    } else {
      $("#msg_no_insurance").removeClass("hidden");

      scrollToBottom();

      setTimeout(function () {
        $("#agentBlock4").removeClass("hidden");
        scrollToBottom();
        setTimeout(function () {
          $(".temp-typing").remove();
          $("#msg13").removeClass("hidden").after(typingEffect());
          scrollToBottom();
          setTimeout(function () {
            $(".temp-typing").remove();
            $("#msg14").removeClass("hidden").after(typingEffect());
            scrollToBottom();
            setTimeout(function () {
              $(".temp-typing").remove();
              $("#msg15").removeClass("hidden").after(typingEffect());
              scrollToBottom();
              setTimeout(function () {
                $(".temp-typing").remove();
                $("#msg16").removeClass("hidden").after(typingEffect());
                scrollToBottom();
                setTimeout(function () {
                  $(".temp-typing").remove();
                  $("#msg17").before(typingEffect());
                  scrollToBottom();
                  setTimeout(function () {
                    $(".temp-typing").remove();
                    // Update phone number reactively before showing button
                    updatePhoneNumberReactive();
                    $("#msg17").removeClass("hidden");
                    scrollToBottom();
                    startCountdown();
                  }, 750);
                }, speed);
              }, speed);
            }, speed);
          }, speed);
        }, speed);
      }, speed);
    }
  }

  if (currentStep == 3) {
    $("#agentBlock4 .agent-chat").prepend(typingEffect());
    $("#msg_q3_2").addClass("hidden");
    $("#userBlock_q3").removeClass("hidden");

    var newUrl = new URL(window.location.href); // Define the URL once
    // Preserve all original parameters first
    newUrl = preserveUrlParams(newUrl);

    if (buttonValue == "Yes") {
      $("#msg_yes_q3").removeClass("hidden");

      newUrl.searchParams.delete("qualified");
      newUrl.searchParams.set("qualified", "yes");
    } else if (buttonValue == "No") {
      $("#msg_no_q3").removeClass("hidden");

      newUrl.searchParams.delete("qualified");
      newUrl.searchParams.set("qualified", "no");
    }

    // Yes: load CallGrid phone before reveal. No: Claim Now only (skip phone).
    (async function () {
      if (buttonValue == "Yes") {
        if (window.callgridConfigOk === false) {
          showTrackingConfigError(
            "Tracking unavailable for this page. Route is missing CallGrid configuration.",
          );
        }
        await updatePhoneNumberReactive();
      }
      scrollToBottom();

      setTimeout(function () {
        $("#agentBlock4").removeClass("hidden");
        scrollToBottom();
        setTimeout(function () {
          $(".temp-typing").remove();
          $("#msg13").removeClass("hidden").after(typingEffect());
          scrollToBottom();
          setTimeout(function () {
            $(".temp-typing").remove();
            $("#msg14").removeClass("hidden").after(typingEffect());
            scrollToBottom();
            setTimeout(function () {
              $(".temp-typing").remove();
              if (buttonValue == "Yes") {
                $("#msg15").removeClass("hidden").after(typingEffect());
              } else if (buttonValue == "No") {
                $("#msg15_no").removeClass("hidden").after(typingEffect());
              }
              scrollToBottom();
              setTimeout(function () {
                $(".temp-typing").remove();
                if (buttonValue == "Yes") {
                  $("#msg17").before(typingEffect());
                } else if (buttonValue == "No") {
                  $("#msg19-contact").before(typingEffect());
                }
                scrollToBottom();
                setTimeout(function () {
                  $(".temp-typing").remove();
                  if (buttonValue == "Yes") {
                    $("#msg19-contact").addClass("hidden");
                    $("#msg17").removeClass("hidden");
                    scrollToBottom();
                    startCountdown();
                  } else if (buttonValue == "No") {
                    $("#msg17").addClass("hidden");
                    $("#msg19-contact").removeClass("hidden");
                    scrollToBottom();
                  }
                }, 750);
              }, speed);
            }, speed);
          }, speed);
        }, speed);
      }, speed);
    })();

    // Update the URL with the new qualified parameter
    window.history.replaceState({}, "", newUrl);
  }
});

function scrollToBottom() {
  var object = $("main");
  $("html, body").animate(
    {
      scrollTop:
        object.offset().top + object.outerHeight() - $(window).height(),
    },
    "fast",
  );
}

function typingEffect() {
  string =
    '<div class="temp-typing bg-gray-200 p-3 rounded-lg shadow-xs mt-2 inline-block">';
  string += '<div class="typing-animation">';
  string += '<div class="typing-dot"></div>';
  string += '<div class="typing-dot"></div>';
  string += '<div class="typing-dot"></div>';
  string += "</div>";
  string += "</div>";
  return string;
}

let userId = localStorage.getItem("user_id");
if (!userId) {
  userId = Math.random().toString(36).substring(2) + Date.now().toString(36);
  localStorage.setItem("user_id", userId);
}

// Google Ads conversion tracking function
function gtag_report_conversion(url) {
  console.log("Google Tag Manager conversion event fired", {
    url: url,
    send_to: "AW-16921817895/4s4iCJv-wb8bEKfm-YQ_",
  });
  var callback = function () {
    if (typeof url != "undefined") {
      window.location = url;
    }
  };
  gtag("event", "conversion", {
    send_to: "AW-16921817895/4s4iCJv-wb8bEKfm-YQ_",
    value: 1.0,
    currency: "USD",
    event_callback: callback,
  });
  return false;
}

// Function to attach click listener to phone button
// MUTED FOR TESTING - Check for double firing
// function attachPhoneButtonListener() {
//   const phoneButton = document.getElementById("phone-number");
//   if (phoneButton && !phoneButton.hasAttribute("data-gtag-listener-attached")) {
//     // Attach the click event listener
//     phoneButton.addEventListener("click", function (e) {
//       const href = this.getAttribute("href");
//       if (href) {
//         // Execute existing onclick handler if present (for fbq tracking)
//         // MUTED FOR TESTING - Check for double firing
//         // const existingOnclick = this.getAttribute("onclick");
//         // if (existingOnclick) {
//         //   try {
//         //     eval(existingOnclick);
//         //   } catch (err) {
//         //     console.error("Error executing existing onclick:", err);
//         //   }
//         // }

//         // Check if user answered "No" to Medicare Part A and Part B question
//         const qualifiedParam = new URL(window.location.href).searchParams.get(
//           "qualified"
//         );

//         // For tel: links, allow default behavior (phone dialer opens)
//         // Don't prevent default so the link works normally
//         if (href.startsWith("tel:")) {
//           // Track conversion without preventing default
//           // MUTED FOR TESTING - Check for double firing
//           // if (qualifiedParam !== "no" && typeof gtag === "function") {
//           //   gtag("event", "conversion", {
//           //     send_to: "AW-16921817895/4s4iCJv-wb8bEKfm-YQ_",
//           //     value: 1.0,
//           //     currency: "USD",
//           //   });
//           // }

//           // Allow the tel: link to work normally (don't prevent default)
//           return;
//         }

//         // For non-tel links, handle navigation
//         e.preventDefault();
//         if (qualifiedParam === "no") {
//           console.log(
//             "Google Tag Manager conversion blocked: User answered 'No' to Medicare Part A and Part B question"
//           );
//           window.location = href;
//           return;
//         }

//         // Call gtag conversion tracking for non-tel links
//         if (typeof gtag_report_conversion === "function") {
//           gtag_report_conversion(href);
//         }
//       }
//     });

//     // Mark as attached to avoid duplicates
//     phoneButton.setAttribute("data-gtag-listener-attached", "true");
//     return true; // Successfully attached
//   }
//   return false; // Button not found yet or already attached
// }

// Try to attach listener when DOM is ready
// MUTED FOR TESTING - Check for double firing
// if (document.readyState === "loading") {
//   document.addEventListener("DOMContentLoaded", function () {
//     attachPhoneButtonListener();
//   });
// } else {
//   // DOM already loaded, try to attach immediately
//   attachPhoneButtonListener();
// }

// Use MutationObserver to watch for when the button becomes visible
// This handles the case where the button is initially hidden
// MUTED FOR TESTING - Check for double firing
// const observer = new MutationObserver(function (mutations) {
//   mutations.forEach(function (mutation) {
//     // Check for when msg17 (parent container) becomes visible
//     if (mutation.type === "attributes" && mutation.attributeName === "class") {
//       const msg17 = document.getElementById("msg17");
//       if (msg17 && !msg17.classList.contains("hidden")) {
//         // Parent is now visible, try to attach listener to phone button
//         attachPhoneButtonListener();
//       }
//     }
//     // Also check for childList changes in case button is added dynamically
//     if (mutation.type === "childList") {
//       attachPhoneButtonListener();
//     }
//   });
// });

// Start observing when DOM is ready
// MUTED FOR TESTING - Check for double firing
// if (document.readyState === "loading") {
//   document.addEventListener("DOMContentLoaded", function () {
//     const msg17 = document.getElementById("msg17");
//     if (msg17) {
//       observer.observe(msg17, {
//         attributes: true,
//         attributeFilter: ["class"],
//         childList: true,
//         subtree: true,
//       });
//     }
//   });
// } else {
//   const msg17 = document.getElementById("msg17");
//   if (msg17) {
//     observer.observe(msg17, {
//       attributes: true,
//       attributeFilter: ["class"],
//       childList: true,
//       subtree: true,
//     });
//   }
// }
