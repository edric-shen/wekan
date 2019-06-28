Settings = new Mongo.Collection('settings');

Settings.attachSchema(
  new SimpleSchema({
    disableRegistration: {
      type: Boolean,
    },
    'mailServer.username': {
      type: String,
      optional: true,
    },
    'mailServer.password': {
      type: String,
      optional: true,
    },
    'mailServer.host': {
      type: String,
      optional: true,
    },
    'mailServer.port': {
      type: String,
      optional: true,
    },
    'mailServer.enableTLS': {
      type: Boolean,
      optional: true,
    },
    'mailServer.from': {
      type: String,
      optional: true,
    },
    productName: {
      type: String,
      optional: true,
    },
    customHTMLafterBodyStart: {
      type: String,
      optional: true,
    },
    customHTMLbeforeBodyEnd: {
      type: String,
      optional: true,
    },
    displayAuthenticationMethod: {
      type: Boolean,
      optional: true,
    },
    defaultAuthenticationMethod: {
      type: String,
      optional: false,
    },
    hideLogo: {
      type: Boolean,
      optional: true,
    },
    createdAt: {
      type: Date,
      denyUpdate: true,
      // eslint-disable-next-line consistent-return
      autoValue() {
        if (this.isInsert) {
          return new Date();
        } else {
          this.unset();
        }
      },
    },
    modifiedAt: {
      type: Date,
      // eslint-disable-next-line consistent-return
      autoValue() {
        if (this.isInsert || this.isUpsert || this.isUpdate) {
          return new Date();
        } else {
          this.unset();
        }
      },
    },
  }),
);
Settings.helpers({
  mailUrl() {
    if (!this.mailServer.host) {
      return null;
    }
    const protocol = this.mailServer.enableTLS ? 'smtps://' : 'smtp://';
    if (!this.mailServer.username && !this.mailServer.password) {
      return `${protocol}${this.mailServer.host}:${this.mailServer.port}/`;
    }
    return `${protocol}${this.mailServer.username}:${encodeURIComponent(
      this.mailServer.password,
    )}@${this.mailServer.host}:${this.mailServer.port}/`;
  },
});
Settings.allow({
  update(userId) {
    const user = Users.findOne(userId);
    return user && user.isAdmin;
  },
});

if (Meteor.isServer) {
  Meteor.startup(() => {
    Settings._collection._ensureIndex({ modifiedAt: -1 });
    const setting = Settings.findOne({});
    if (!setting) {
      const now = new Date();
      const domain = process.env.ROOT_URL.match(
        /\/\/(?:www\.)?(.*)?(?:\/)?/,
      )[1];
      const from = `Boards Support <support@${domain}>`;
      const defaultSetting = {
        disableRegistration: false,
        mailServer: {
          username: '',
          password: '',
          host: '',
          port: '',
          enableTLS: false,
          from,
        },
        createdAt: now,
        modifiedAt: now,
        displayAuthenticationMethod: true,
        defaultAuthenticationMethod: 'password',
      };
      Settings.insert(defaultSetting);
    }
    const newSetting = Settings.findOne();
    if (!process.env.MAIL_URL && newSetting.mailUrl())
      process.env.MAIL_URL = newSetting.mailUrl();
    Accounts.emailTemplates.from = process.env.MAIL_FROM
      ? process.env.MAIL_FROM
      : newSetting.mailServer.from;
  });
  Settings.after.update((userId, doc, fieldNames) => {
    // assign new values to mail-from & MAIL_URL in environment
    if (_.contains(fieldNames, 'mailServer') && doc.mailServer.host) {
      const protocol = doc.mailServer.enableTLS ? 'smtps://' : 'smtp://';
      if (!doc.mailServer.username && !doc.mailServer.password) {
        process.env.MAIL_URL = `${protocol}${doc.mailServer.host}:${doc.mailServer.port}/`;
      } else {
        process.env.MAIL_URL = `${protocol}${
          doc.mailServer.username
        }:${encodeURIComponent(doc.mailServer.password)}@${
          doc.mailServer.host
        }:${doc.mailServer.port}/`;
      }
      Accounts.emailTemplates.from = doc.mailServer.from;
    }
  });

  function getRandomNum(min, max) {
    const range = max - min;
    const rand = Math.random();
    return min + Math.round(rand * range);
  }

  function getEnvVar(name) {
    const value = process.env[name];
    if (value) {
      return value;
    }
    throw new Meteor.Error([
      'var-not-exist',
      `The environment variable ${name} does not exist`,
    ]);
  }

  function sendInvitationEmail(_id) {
    const icode = InvitationCodes.findOne(_id);
    const author = Users.findOne(Meteor.userId());
    try {
      const params = {
        email: icode.email,
        inviter: Users.findOne(icode.authorId).username,
        user: icode.email.split('@')[0],
        icode: icode.code,
        url: FlowRouter.url('sign-up'),
      };
      const lang = author.getLanguage();

      Email.send({
        to: icode.email,
        from: Accounts.emailTemplates.from,
        subject: TAPi18n.__('email-invite-register-subject', params, lang),
        text: TAPi18n.__('email-invite-register-text', params, lang),
      });
    } catch (e) {
      InvitationCodes.remove(_id);
      throw new Meteor.Error('email-fail', e.message);
    }
  }

  function isLdapEnabled() {
    return process.env.LDAP_ENABLE === 'true';
  }

  function isOauth2Enabled() {
    return process.env.OAUTH2_ENABLED === 'true';
  }

  function isCasEnabled() {
    return process.env.CAS_ENABLED === 'true';
  }

  Meteor.methods({
    sendInvitation(emails, boards) {
      check(emails, [String]);
      check(boards, [String]);

      const user = Users.findOne(Meteor.userId());
      if (!user.isAdmin) {
        throw new Meteor.Error('not-allowed');
      }
      emails.forEach(email => {
        if (email && SimpleSchema.RegEx.Email.test(email)) {
          // Checks if the email is already link to an account.
          const userExist = Users.findOne({ email });
          if (userExist) {
            throw new Meteor.Error(
              'user-exist',
              `The user with the email ${email} has already an account.`,
            );
          }
          // Checks if the email is already link to an invitation.
          const invitation = InvitationCodes.findOne({ email });
          if (invitation) {
            InvitationCodes.update(invitation, {
              $set: { boardsToBeInvited: boards },
            });
            sendInvitationEmail(invitation._id);
          } else {
            const code = getRandomNum(100000, 999999);
            InvitationCodes.insert(
              {
                code,
                email,
                boardsToBeInvited: boards,
                createdAt: new Date(),
                authorId: Meteor.userId(),
              },
              function(err, _id) {
                if (!err && _id) {
                  sendInvitationEmail(_id);
                } else {
                  throw new Meteor.Error(
                    'invitation-generated-fail',
                    err.message,
                  );
                }
              },
            );
          }
        }
      });
    },

    sendSMTPTestEmail() {
      if (!Meteor.userId()) {
        throw new Meteor.Error('invalid-user');
      }
      const user = Meteor.user();
      if (!user.emails && !user.emails[0] && user.emails[0].address) {
        throw new Meteor.Error('email-invalid');
      }
      this.unblock();
      const lang = user.getLanguage();
      try {
        Email.send({
          to: user.emails[0].address,
          from: Accounts.emailTemplates.from,
          subject: TAPi18n.__('email-smtp-test-subject', { lng: lang }),
          text: TAPi18n.__('email-smtp-test-text', { lng: lang }),
        });
      } catch ({ message }) {
        throw new Meteor.Error(
          'email-fail',
          `${TAPi18n.__('email-fail-text', { lng: lang })}: ${message}`,
          message,
        );
      }
      return {
        message: 'email-sent',
        email: user.emails[0].address,
      };
    },

    getCustomUI() {
      const setting = Settings.findOne({});
      if (!setting.productName) {
        return {
          productName: '',
        };
      } else {
        return {
          productName: `${setting.productName}`,
        };
      }
    },

    getMatomoConf() {
      return {
        address: getEnvVar('MATOMO_ADDRESS'),
        siteId: getEnvVar('MATOMO_SITE_ID'),
        doNotTrack: process.env.MATOMO_DO_NOT_TRACK || false,
        withUserName: process.env.MATOMO_WITH_USERNAME || false,
      };
    },

    _isLdapEnabled() {
      return isLdapEnabled();
    },

    _isOauth2Enabled() {
      return isOauth2Enabled();
    },

    _isCasEnabled() {
      return isCasEnabled();
    },

    // Gets all connection methods to use it in the Template
    getAuthenticationsEnabled() {
      return {
        ldap: isLdapEnabled(),
        oauth2: isOauth2Enabled(),
        cas: isCasEnabled(),
      };
    },

    getDefaultAuthenticationMethod() {
      return process.env.DEFAULT_AUTHENTICATION_METHOD;
    },
  });
}

export default Settings;
