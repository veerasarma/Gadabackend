const db = require("../config/db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const {
  verifyEmailFormat,
  verifyUsernameFormat,
  validName,
} = require("../services/userService.js");
const {
  getClientIP,
  getDateTime,
  getHashKey,
  getHashToken,
  getUserBrowser,
  getUserOS,
  getSystemProtocol,
} = require("../utils/helpers.js");
const { sendEmail } = require("../utils/mailer.js");
const { secureUserObject, secure } = require("../utils/secure");
const { ValidationException, BadRequestException } = require("../utils/errors");
const { getEmailTemplate } = require("../utils/emailTemplate");
const { v4: uuid } = require("uuid");
const { getClientIp, parseUserAgent } = require('../utils/clientInfo');
const { checkActivePackage } = require("../services/packageService");

exports.getProfile = (req, res) => {
  const user = req.user;
  res.json({
    id: user.user_id,
    name: `${user.user_firstname} ${user.user_lastname}`,
    email: user.user_email,
    role: user.user_group,
    session: user.session_token,
  });
};

exports.activation = async (req, res, next) => {
  try {
    const emailverificationcode = req.body;
    console.log(emailverificationcode, "emailverificationcode");
    if (!emailverificationcode?.token)
      throw new ValidationException("Send valid emailverificationcode");
    let token = emailverificationcode.token;
    console.log(token, "tokentokentoken");
    const whereQuery = "user_email_verification_code = " + token;
    const [user] = await db.query(
      `SELECT user_id FROM users WHERE ${whereQuery}`
    );
    console.log(user, "useruser");
    if (user != "") {
      console.log(user, "user");
      let user_id = user[0].user_id;
      console.log(user_id, "user");

      console.log("first if");
      let updatedata = await db.query(
        'UPDATE users SET user_approved = "1" WHERE user_id = ?',
        [user_id]
      );
      if (updatedata) {
        console.log("second if", updatedata);
        res.json({ status: "success", userdata: user_id });
      }
    } else {
      throw new ValidationException("Invalid verification code ");
    }
    // console.log(emailverificationcode,'emailverificationcode')
  } catch (err) {
    next(err);
  }
};

exports.signUp = async (req, res, next) => {
  // const system = req.system;
  // const date = getDateTime();
  // const args = req.body;
  // const device_info = args.device_info || {};
  // const fromWeb = args.from_web ?? true;
  // const email_verification_code = '123456'
  // const subject = `Just one more step to get started on ${system.system_title}`;
  // const mailheader = {
  //   "List-Unsubscribe": `<mailto:unsubscribe@gada.chat>, <${system.system_url}/unsubscribe?email=${args.email}>`
  // }
  //     const name = system.show_usernames_enabled
  //       ? args.username
  //       : `${args.firstname} ${args.lastname}`;
  //     //   console.log("before mail tesmpl")
  //     //   const body = getEmailTemplate('activation_email', subject, { name, email_verification_code });
  //     //   console.log("after mail tesmpl")
  //     //   await sendEmail(args.email, subject, body.html, body.plain);
  //     console.log(system.system_url, "system.system_url");
  //     console.log(args.email, "args.email");

  //     await sendEmail(args.email,mailheader, subject, "activation_email", {
  //       name,
  //       email_verification_code,
  //       system: {
  //         system_url: system.system_url,
  //         system_title: system.system_title,
  //       },
  //     });
  //     console.log("after send mail ");

  //     return false;
  try {
    const system = req.system;
    const date = getDateTime();
    const args = req.body;
    const device_info = args.device_info || {};
    const fromWeb = args.from_web ?? true;

    if (!system.registration_enabled) {
      throw new AuthorizationError("Registration is closed right now");
    }

    console.log(args);
    if (!validName(args.firstname, system))
      throw new ValidationException(
        "Your first name contains invalid characters"
      );
    if (args.firstname.length < system.name_min_length)
      throw new ValidationException(
        `Your first name must be at least ${system.name_min_length} characters long`
      );
    if (!validName(args.lastname, system))
      throw new ValidationException(
        "Your last name contains invalid characters"
      );
    if (args.lastname.length < system.name_min_length)
      throw new ValidationException(
        `Your last name must be at least ${system.name_min_length} characters long`
      );

    if (!verifyUsernameFormat(args.username))
      throw new ValidationException(
        "Please enter a valid username (a-z0-9_.) with minimum 3 characters long"
      );
    if (await reservedUsername(args.username, system))
      throw new ValidationException(
        `You can't use ${args.username} as username`
      );
    if (await getUserByUsername(args.username))
      throw new ValidationException(`${args.username} already exists`);

    if (!verifyEmailFormat(args.email))
      throw new ValidationException("Please enter a valid email address");
    if (await getUserByEmail(args.email, system))
      throw new ValidationException(`${args.email} already exists`);

    // if (system.activation_enabled && system.activation_type === 'sms') {
    //   if (!args.phone) throw new ValidationException("Please enter a valid phone number");
    //   if (await checkPhone(args.phone)) throw new ValidationException(`${args.phone} already exists`);
    // } else {
    //   args.phone = null;
    // }

    checkPassword(args.password, system);

    // args.gender = system.genders_disabled ? 1 : args.gender;
    // if (!system.genders_disabled && !(await checkGender(args.gender))) {
    //   throw new ValidationException("Please select a valid gender");
    // }

    // if (Number(system.age_restriction)) {
    //   if (![...Array(13).keys()].includes(parseInt(args.birth_month))) throw new ValidationException("Please select a valid birth month (1-12)");
    //   if (![...Array(32).keys()].includes(parseInt(args.birth_day))) throw new ValidationException("Please select a valid birth day (1-31)");
    //   if (args.birth_year < 1905 || args.birth_year > 2017) throw new ValidationException("Please select a valid birth year (1905-2017)");
    //   if (new Date().getFullYear() - args.birth_year < system.minimum_age) throw new ValidationException(`You must be ${system.minimum_age} years old to register`);
    //   args.birth_date = `${args.birth_year}-${args.birth_month}-${args.birth_day}`;
    // } else {
    //   args.birth_date = null;
    // }

    // const custom_fields = await setCustomFields(args);

    // if (Number(system.reCAPTCHA_enabled) && fromWeb && !(await validateRecaptcha(args['g-recaptcha-response'], getClientIP(req)))) {
    //   throw new ValidationException("The security check is incorrect. Please try again");
    // }

    //   if (system.turnstile_enabled && fromWeb && !(await validateTurnstile(args['cf-turnstile-response']))) {
    //     throw new ValidationException("The security check is incorrect. Please try again");
    //   }

    // let custom_user_group = '0';
    // console.log(system.select_user_group_enabled,'system.select_user_group_enabled')
    // if (Number(system.select_user_group_enabled)) {
    //   if (!args.custom_user_group || args.custom_user_group === 'none') throw new ValidationException("Please select a valid user group");
    //   custom_user_group = await checkUserGroup(args.custom_user_group) ? args.custom_user_group : '0';
    // } else {
    //   custom_user_group = await checkUserGroup(system.default_custom_user_group) ? system.default_custom_user_group : '0';
    // }

    // const newsletter_agree = args.newsletter_agree ? '1' : '0';

    // if (!args.privacy_agree && fromWeb) throw new ValidationException("You must agree to the privacy policy");

    const email_verification_code = getHashKey(6, true);
    const phone_verification_code =
      Number(system.activation_enabled) && system.activation_type === "sms"
        ? getHashKey(6, true)
        : null;
    const user_approved = system.users_approval_enabled ? "0" : "1";

    const hashedPassword = await bcrypt.hash(args.password, 10);

    const [insertResult] = await db.query(
      `
        INSERT INTO users ( user_name, user_email, user_password, user_firstname, user_lastname, user_email_verification_code, user_approved)
        VALUES (  ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        args.username,
        args.email,
        hashedPassword,
        capitalize(args.firstname),
        capitalize(args.lastname),
        email_verification_code,
        user_approved,
      ]
    );

    const user_id = insertResult.insertId;

    // await setDefaultPrivacy(user_id,system);

    // if (custom_fields) {
    //   for (const field_id in custom_fields) {
    //     await db.query('INSERT INTO custom_fields_values (value, field_id, node_id, node_type) VALUES (?, ?, ?, ?)', [custom_fields[field_id], field_id, user_id, 'user']);
    //   }
    // }

    if (system.activation_enabled) {
      const subject = `Just one more step to get started on ${system.system_title}`;
      const name = system.show_usernames_enabled
        ? args.username
        : `${args.firstname} ${args.lastname}`;
      //   console.log("before mail tesmpl")
      //   const body = getEmailTemplate('activation_email', subject, { name, email_verification_code });
      //   console.log("after mail tesmpl")
      //   await sendEmail(args.email, subject, body.html, body.plain);
      console.log(system.system_url, "system.system_url");
      console.log(system.system_title, "system.system_title");

      
      const mailheader = {
        "List-Unsubscribe": `<mailto:unsubscribe@gada.chat>, <${system.system_url}/unsubscribe?email=${args.email}>`
      }

      await sendEmail(args.email, mailheader, subject, "activation_email", {
        name,
        email_verification_code,
        system: {
          system_url: system.system_url,
          system_title: system.system_title,
        },
      });
      console.log("after send mail ");
      // } else {
      //   const message = `${system.system_title} Activation Code: ${phone_verification_code}`;
      //   await sendSMS(args.phone, message);
      // }
    } else {
      await processAffiliates("registration", user_id);
    }

    //   if (system.invitation_enabled) {
    //     await updateInvitationCode(args.invitation_code, user_id);
    //   }

    //   await autoFriend(user_id);
    //   await autoFollow(user_id);
    //   await autoLike(user_id);
    //   await autoJoin(user_id);

    //   if (system.users_approval_enabled) {
    //     await notifyAdmins('pending_user', true, user_id);
    //   }

    const token = jwt.sign({ userId: user_id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });
    const [userResult] = await db.query(
      "SELECT * FROM users WHERE user_id = ?",
      [user_id]
    );
    const secureUser = secureUserObject(userResult[0]);
    res.json({ token, user: secureUser });
  } catch (err) {
    next(err);
  }
};

const checkInvitationCode = async (code) => {
  try {
    const [rows] = await db.query(
      "SELECT COUNT(*) as count FROM invitation_codes WHERE code = ? AND used = ?",
      [secure(code), "0"]
    );

    return rows[0].count > 0;
  } catch (err) {
    console.error("Error checking invitation code:", err);
    throw err;
  }
};

const notifyAdmins = async (
  action,
  notifyModerators = false,
  fromUserId = null,
  req = null
) => {
  const db = (await import("../utils/db.js")).default;
  const system = req.system || global.system;
  const user = req.userInstance;
  const { postNotification } = await import(
    "../services/notificationService.js"
  );

  const effectiveUserId = fromUserId || user?.user_id;
  const whereQuery = notifyModerators ? "user_group < 3" : "user_group = 1";

  const [admins] = await db.query(
    `SELECT user_id FROM users WHERE ${whereQuery}`
  );
  if (!admins.length) return;

  for (const admin of admins) {
    await postNotification({
      from_user_id: effectiveUserId,
      to_user_id: admin.user_id,
      action,
    });
  }
};

const setAuthCookies = async (res, userId, remember = false, system, req) => {
  const sessionToken = getHashToken(); // Secure token generator
  const sessionDate = getDateTime(); // Current date-time
  const userIP = getClientIP(res);
  const userBrowser = getUserBrowser(res);
  const userOS = getUserOS(res);

  // Reset failed login count if brute force protection enabled
  if (system.brute_force_detection_enabled) {
    await db.query(
      "UPDATE users SET user_failed_login_count = 0 WHERE user_id = ?",
      [userId]
    );
  }

  // Insert user session
  await db.query(
    `
      INSERT INTO users_sessions (session_token, session_date, user_id, user_ip, user_browser, user_os)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [sessionToken, sessionDate, userId, userIP, userBrowser, userOS]
  );

  // Cookie settings
  const isSecure = getSystemProtocol() === "https";
  const cookieOptions = {
    httpOnly: true,
    secure: isSecure,
    sameSite: "Lax",
    path: "/",
    ...(remember ? { maxAge: 30 * 24 * 60 * 60 * 1000 } : {}), // 30 days if remember is true
  };

  // Set cookies
  res.cookie("uid", userId, cookieOptions);
  res.cookie("utoken", sessionToken, cookieOptions);
};

const setDefaultPrivacy = async (userId, system) => {
  // const system = global.system || {}; // Use globally initialized or pass in explicitly

  await db.query(
    `UPDATE users SET 
        user_privacy_chat = ?,
        user_privacy_poke = ?,
        user_privacy_gifts = ?,
        user_privacy_wall = ?,
        user_privacy_gender = ?, 
        user_privacy_relationship = ?,
        user_privacy_birthdate = ?, 
        user_privacy_basic = ?, 
        user_privacy_work = ?, 
        user_privacy_location = ?, 
        user_privacy_education = ?, 
        user_privacy_other = ?, 
        user_privacy_friends = ?, 
        user_privacy_followers = ?, 
        user_privacy_subscriptions = ?, 
        user_privacy_photos = ?, 
        user_privacy_pages = ?, 
        user_privacy_groups = ?, 
        user_privacy_events = ?
      WHERE user_id = ?`,
    [
      system.user_privacy_chat,
      system.user_privacy_poke,
      system.user_privacy_gifts,
      system.user_privacy_wall,
      system.user_privacy_gender,
      system.user_privacy_relationship,
      system.user_privacy_birthdate,
      system.user_privacy_basic,
      system.user_privacy_work,
      system.user_privacy_location,
      system.user_privacy_education,
      system.user_privacy_other,
      system.user_privacy_friends,
      system.user_privacy_followers,
      system.user_privacy_subscriptions,
      system.user_privacy_photos,
      system.user_privacy_pages,
      system.user_privacy_groups,
      system.user_privacy_events,
      userId,
    ]
  );
};

const checkUserGroup = async (userGroupId) => {
  const [rows] = await db.query(
    `SELECT COUNT(*) as count
       FROM users_groups
       INNER JOIN permissions_groups ON users_groups.permissions_group_id = permissions_groups.permissions_group_id
       WHERE user_group_id = ?`,
    [userGroupId]
  );

  return rows[0]?.count > 0;
};

function capitalize(str) {
  // Handle empty or non-string inputs
  if (typeof str !== "string" || str.length === 0) {
    return "";
  }

  return str
    .split(" ")
    .map((word) => {
      if (word.length === 0) {
        return ""; // Handle multiple spaces
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

const setCustomFields = async (
  inputFields,
  forType = "user",
  set = "registration",
  nodeId = null
) => {
  const system = global.system; // Use from middleware or pass explicitly if needed
  const customFields = {};

  if (
    ![
      "user",
      "page",
      "group",
      "event",
      "product",
      "job",
      "offer",
      "course",
    ].includes(forType)
  ) {
    throw new BadRequestException("Invalid field for");
  }
  if (!["registration", "settings"].includes(set)) {
    throw new BadRequestException("Invalid field set");
  }

  const whereQuery = `${
    set === "registration" ? "AND in_registration = '1'" : ""
  } AND field_for = ?`;

  const prefix = "fld_";
  const prefixLength = prefix.length;

  for (const key in inputFields) {
    if (!key.startsWith(prefix)) continue;
    const fieldId = key.substring(prefixLength);
    const [fieldResult] = await db.query(
      `SELECT * FROM custom_fields WHERE field_id = ? ${whereQuery}`,
      [fieldId, forType]
    );
    if (fieldResult.length === 0) continue;
    const field = fieldResult[0];
    const value = inputFields[key];

    if (field.mandatory) {
      if (field.type === "selectbox" && value === "none") {
        throw new ValidationException(`You must select ${field.label}`);
      }
      if (
        field.type === "multipleselectbox" &&
        (!Array.isArray(value) || value.length === 0)
      ) {
        throw new ValidationException(
          `You must select at least one option from ${field.label}`
        );
      }
      if (
        (field.type === "textbox" || field.type === "textarea") &&
        (!value || value.trim() === "")
      ) {
        throw new ValidationException(`You must enter ${field.label}`);
      }
    }

    if (
      (field.type === "textbox" || field.type === "textarea") &&
      value.length > field.length
    ) {
      throw new ValidationException(
        `The maximum value for ${field.label} is ${field.length}`
      );
    }

    const fieldValue =
      field.type === "multipleselectbox" ? value.join(",") : value;

    if (set === "registration") {
      customFields[field.field_id] = fieldValue;
    } else {
      if (!nodeId) throw new BadRequestException();
      const [exists] = await db.query(
        "SELECT * FROM custom_fields_values WHERE field_id = ? AND node_id = ? AND node_type = ?",
        [field.field_id, nodeId, forType]
      );
      if (exists.length > 0) {
        await db.query(
          "UPDATE custom_fields_values SET value = ? WHERE field_id = ? AND node_id = ? AND node_type = ?",
          [fieldValue, field.field_id, nodeId, forType]
        );
      } else {
        await db.query(
          "INSERT INTO custom_fields_values (value, field_id, node_id, node_type) VALUES (?, ?, ?, ?)",
          [fieldValue, field.field_id, nodeId, forType]
        );
      }
    }
  }

  if (set === "registration") {
    return customFields;
  }
};

const checkGender = async (genderId) => {
  const [rows] = await db.query(
    "SELECT COUNT(*) as count FROM system_genders WHERE gender_id = ?",
    [genderId]
  );
  return rows[0].count > 0;
};

const checkPhone = async (phone) => {
  const [rows] = await db.query(
    "SELECT COUNT(*) as count FROM users WHERE user_phone = ?",
    [phone]
  );
  return rows[0].count > 0;
};

const checkPassword = (password, system) => {
  if (password.length < 6) {
    throw new ValidationException(
      "Your password must be at least 6 characters long. Please try another"
    );
  }
  if (password.length > 64) {
    throw new ValidationException(
      "Your password must be less than 64 characters long. Please try another"
    );
  }
  if (system.password_complexity_enabled) {
    if (!/[A-Z]/.test(password)) {
      throw new ValidationException(
        "Your password must contain at least one uppercase letter. Please try another"
      );
    }
    if (!/[a-z]/.test(password)) {
      throw new ValidationException(
        "Your password must contain at least one lowercase letter. Please try another"
      );
    }
    if (!/[0-9]/.test(password)) {
      throw new ValidationException(
        "Your password must contain at least one number. Please try another"
      );
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};:"\\|,.<>\/?]+/.test(password)) {
      throw new ValidationException(
        "Your password must contain at least one special character. Please try another"
      );
    }
  }
};

const reservedUsername = async (username, system) => {
  if (!system.reserved_usernames_enabled) return false;

  try {
    const reservedList = JSON.parse(system.reserved_usernames);
    const reservedUsernames = reservedList.map((item) =>
      item.value.toLowerCase()
    );
    return reservedUsernames.includes(username.toLowerCase());
  } catch (e) {
    return false;
  }
};

const checkIP = async (ip, system) => {
  if (system.max_accounts > 0) {
    const [rows] = await db.query(
      `SELECT user_ip, COUNT(DISTINCT user_id) as total FROM users_sessions WHERE user_ip = ? GROUP BY user_id`,
      [ip]
    );
    if (rows.length >= system.max_accounts) {
      throw new ValidationException(
        "You have reached the maximum number of account for your IP"
      );
    }
  }
};

async function getUserByEmail(email, system) {
  console.log("valid email", email);
  const emailDomain = email.split("@")[1];
  const domainParts = emailDomain.split(".");
  const emailLastDomain = `${domainParts[domainParts.length - 2]}.${
    domainParts[domainParts.length - 1]
  }`;

  // if (system.whitelist_enabled) {
  //   if (system.whitelist_providers) {
  //     const whitelistProviders = JSON.parse(system.whitelist_providers).map(p => p.value);
  //     if (whitelistProviders.length && !whitelistProviders.includes(emailDomain)) {
  //       throw new ValidationException(`Only emails from the following providers are allowed (${whitelistProviders.join(', ')})`);
  //     }
  //   }
  // } else {
  const [banned] = await db.query(
    'SELECT COUNT(*) as count FROM blacklist WHERE node_type = "email" AND (node_value = ? OR node_value = ?)',
    [emailDomain, emailLastDomain]
  );
  if (banned[0].count > 0) {
    throw new ValidationException(
      `Sorry but this provider ${emailDomain} is not allowed in our system`
    );
  }
  // }

  const [results] = await db.query("SELECT * FROM users WHERE user_email = ?", [
    email,
  ]);
  return results.length > 0 ? results[0] : false;
}

async function getUserByUsername(username, type = "user") {
  const [banned] = await db.query(
    'SELECT COUNT(*) as count FROM blacklist WHERE node_type = "username" AND node_value = ?',
    [username]
  );
  if (banned[0].count > 0) {
    throw new ValidationException(
      `Sorry but this username ${username} is not allowed in our system`
    );
  }

  let query;
  switch (type) {
    case "page":
      query = "SELECT * FROM pages WHERE page_name = ?";
      break;
    case "group":
      query = "SELECT * FROM `groups` WHERE group_name = ?";
      break;
    default:
      query = "SELECT * FROM users WHERE user_name = ?";
  }

  const [results] = await db.query(query, [username]);
  return results.length > 0 ? results[0] : false;
}

exports.signIn = async (req, res, next) => {
  try {
    const {
      email,
      password,
      remember = false,
      from_web = false,
      device_info = {},
      connecting_account = false,
    } = req.body;
    const system = req.system;
    const username_email = email;
    if (!username_email?.trim() || !password) {
      throw new ValidationException("You must fill in all of the fields");
    }

    let user, field;
    const identifier = username_email.trim();

    if (verifyEmailFormat(identifier)) {
      user = await getUserByEmail(identifier, system);
      if (!user)
        throw new ValidationException(
          "The email you entered does not belong to any account"
        );
      field = "email";
    } else {
      if (!verifyUsernameFormat(identifier))
        throw new ValidationException(
          "Please enter a valid email address or username"
        );
      user = await getUserByUsername(identifier);
      if (!user)
        throw new ValidationException(
          "The username you entered does not belong to any account"
        );
      field = "username";
    }

      const validPassword = await bcrypt.compare(password, user.user_password);
      if (!validPassword) {
        // Update brute-force counters
        const now = getDateTime();
        const userId = user.id;
  
        throw new ValidationException('Please re-enter your password. The password you entered is incorrect');
      }
  
     
      if(user.user_approved != '1')
      {
        throw new ValidationException('Your account still not activated');
      }
  
      // JWT generation
      
      const roles = user.user_group==1?'admin':(user.user_group==3?'user':'moderator'); // returns ['admin'] | ['user']...
      console.log(roles,'rolesrolesroles')
      const payload = { userId: user.user_id,email: user.email, roles };
      user.role = roles;

      const pkg = await checkActivePackage(user.user_id).catch(() => ({ active: false }));
      user.packageactive = pkg.active;
      user.packageName = pkg.packageName;

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: remember ? "30d" : "1d",
    });

      const sessionId = uuid();
      const ip = getClientIp(req);
      const {
        userAgent,
        browserName,
        browserVersion,
        osName,
        osVersion,
        deviceType,
      } = parseUserAgent(req.headers['user-agent']);
      await db.query(
      'INSERT INTO users_sessions (session_token, user_id, user_browser, user_os, user_os_version,user_ip, user_device_name,session_date) VALUES (?,?,?,?,?,?,?,NOW())',
      [sessionId, user.user_id || null,browserName,osName,osVersion, ip || null,deviceType]
      );
      req.sessionId = sessionId
  
      const secureUser = await secureUserObject(user);
  
      return res.json({ token, user: secureUser });
  
    } catch (err) {
      next(err);
    }
  };

async function getUserRoles(userId) {
  // Variant 1 (ENUM):
  // const [[row]] = await pool.query('SELECT role FROM users WHERE user_id=?', [userId]);
  // return row?.role ? [row.role] : ['user'];

  // Variant 2 (roles table):
  const [rows] = await db.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id WHERE ur.user_id=?`,
    [userId]
  );
  return rows.map((r) => r.name);
}

exports.sendOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!verifyEmailFormat(email)) {
      throw new ValidationException("Please enter a valid email address");
    }

    const system = req.system;
    const user = await getUserByEmail(email, system);

    if (!user) {
      throw new ValidationException(
        "The email you entered does not belong to any account"
      );
    }

    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Store OTP in DB with expiry
    await db.query(
      `UPDATE users SET password_reset_otp = ?, password_reset_expires = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE user_id = ?`,
      [otp, user.user_id]
    );

    // Send OTP via email
    const subject = `${system.system_title} Password Reset Code`;
    const name = system.show_usernames_enabled
      ? user.user_name
      : `${user.user_firstname} ${user.user_lastname}`;
      const mailheader = {
        "List-Unsubscribe": `<mailto:unsubscribe@gada.chat>, <${system.system_url}/unsubscribe?email=${email}>`
      }

    await sendEmail(email, mailheader,subject, "send_forgot_otp", {
      name,
      otp,
      system: {
        system_url: system.system_url,
        system_title: system.system_title,
      },
    });

    return res.json({
      status: true,
      message: "OTP has been sent to your email address",
    });
  } catch (err) {
    next(err);
  }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    const system = req.system;

    if (!verifyEmailFormat(email)) {
      throw new ValidationException("Please enter a valid email address");
    }
    if (!otp || otp.length !== 4 || !/^\d{4}$/.test(otp)) {
      throw new ValidationException("Invalid OTP format");
    }

    const user = await getUserByEmail(email, system);
    if (!user) {
      throw new ValidationException(
        "The email you entered does not belong to any account"
      );
    }

    // Get OTP and expiry from DB
    const [rows] = await db.query(
      `SELECT password_reset_otp, password_reset_expires FROM users WHERE user_id = ?`,
      [user.user_id]
    );

    if (!rows.length || rows[0].password_reset_otp !== otp) {
      throw new ValidationException("Invalid OTP");
    }

    if (new Date(rows[0].password_reset_expires) < new Date()) {
      throw new ValidationException("OTP expired");
    }

    // If valid
    return res.json({
      status: true,
      message: "OTP verified successfully",
    });
  } catch (err) {
    next(err);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { email, otp, password } = req.body;
    const system = req.system;

    if (!verifyEmailFormat(email)) {
      throw new ValidationException("Please enter a valid email address");
    }
    if (!otp || otp.length !== 4 || !/^\d{4}$/.test(otp)) {
      throw new ValidationException("Invalid OTP format");
    }

    const user = await getUserByEmail(email, system);
    if (!user) {
      throw new ValidationException(
        "The email you entered does not belong to any account"
      );
    }

    // Check OTP and expiry
    const [rows] = await db.query(
      `SELECT password_reset_otp, password_reset_expires FROM users WHERE user_id = ?`,
      [user.user_id]
    );

    if (!rows.length || rows[0].password_reset_otp !== otp) {
      throw new ValidationException("Invalid OTP");
    }
    if (new Date(rows[0].password_reset_expires) < new Date()) {
      throw new ValidationException("OTP expired");
    }

    // Update password
    checkPassword(password, system);
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query(
      `UPDATE users SET user_password = ?, password_reset_otp = NULL, password_reset_expires = NULL WHERE user_id = ?`,
      [hashedPassword, user.user_id]
    );

    return res.json({
      status: true,
      message: "Your password has been reset successfully",
    });
  } catch (err) {
    next(err);
  }
};

exports.resendOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    const system = req.system;

    if (!verifyEmailFormat(email)) {
      throw new ValidationException("Please enter a valid email address");
    }

    const user = await getUserByEmail(email, system);
    if (!user) {
      throw new ValidationException(
        "The email you entered does not belong to any account"
      );
    }

    // Generate new 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Update OTP in DB
    await db.query(
      `UPDATE users 
       SET password_reset_otp = ?, password_reset_expires = DATE_ADD(NOW(), INTERVAL 10 MINUTE) 
       WHERE user_id = ?`,
      [otp, user.user_id]
    );

    // Send email
    const subject = `${system.system_title} New Password Reset Code`;
    const name = system.show_usernames_enabled
      ? user.user_name
      : `${user.user_firstname} ${user.user_lastname}`;
    await sendEmail(email, subject, "password_reset_email", {
      name,
      otp,
      system: {
        system_url: system.system_url,
        system_title: system.system_title,
      },
    });

    res.json({
      status: true,
      message: "A new OTP has been sent to your email",
    });
  } catch (err) {
    next(err);
  }
};
