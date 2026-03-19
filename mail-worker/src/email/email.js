import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';

const RELAY_DEFAULT_PREFIXES = ['relay'];
const RELAY_DEFAULT_TARGET_DOMAINS = [];

function parseList(str) {
	if (!str) {
		return [];
	}

	return String(str)
		.split(',')
		.map(item => item.trim().toLowerCase())
		.filter(Boolean);
}

function normalizeEnvText(value) {
	if (value === undefined || value === null) {
		return '';
	}

	const text = String(value).trim();

	if (/^\$\{[A-Z0-9_]+\}$/.test(text)) {
		return '';
	}

	return text;
}

function parseEnvBool(value, defaultValue) {
	const text = normalizeEnvText(value).toLowerCase();

	if (!text) {
		return defaultValue;
	}

	return ['1', 'true', 'yes', 'on'].includes(text);
}

function getRelayConfig(env) {
	const relayPrefixes = parseList(normalizeEnvText(env?.relay_prefixes) || RELAY_DEFAULT_PREFIXES.join(','));
	const relayTargetDomains = parseList(normalizeEnvText(env?.relay_target_domains));

	return {
		relayEnabled: parseEnvBool(env?.relay_enabled, true),
		relayPrefixes: relayPrefixes.length > 0 ? relayPrefixes : RELAY_DEFAULT_PREFIXES,
		relayTargetDomains: relayTargetDomains.length > 0 ? relayTargetDomains : RELAY_DEFAULT_TARGET_DOMAINS
	};
}

function isEmail(value) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeBase64UrlDecode(value) {
	try {
		let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
		const pad = base64.length % 4;
		if (pad) {
			base64 += '='.repeat(4 - pad);
		}
		return atob(base64);
	} catch (e) {
		return '';
	}
}

function tryDecodeRelayTarget(payload) {
	const candidates = [];

	if (payload.includes('=') && !payload.includes('@')) {
		const idx = payload.indexOf('=');
		candidates.push(`${payload.slice(0, idx)}@${payload.slice(idx + 1)}`);
	}

	if (payload.includes('--at--')) {
		candidates.push(payload.replace('--at--', '@'));
	}

	if (payload.includes('%')) {
		try {
			candidates.push(decodeURIComponent(payload));
		} catch (e) {
			// Ignore invalid URI payloads.
		}
	}

	const decoded = safeBase64UrlDecode(payload);
	if (decoded) {
		candidates.push(decoded);
	}

	if (payload.includes('@')) {
		candidates.push(payload);
	}

	for (const candidate of candidates) {
		const email = candidate.trim().toLowerCase();
		if (isEmail(email)) {
			return email;
		}
	}

	return '';
}

function resolveRelayRecipient(messageTo, relayConfig) {
	if (!relayConfig.relayEnabled) {
		return '';
	}

	if (!messageTo || !messageTo.includes('@')) {
		return '';
	}

	const [localRaw] = messageTo.split('@');
	const localLower = localRaw.toLowerCase();
	const relayPrefixes = relayConfig.relayPrefixes;

	if (relayPrefixes.length === 0) {
		return '';
	}

	const matchedPrefix = relayPrefixes.find(prefix => localLower.startsWith(`${prefix}+`));
	if (!matchedPrefix) {
		return '';
	}

	const payload = localRaw.slice(matchedPrefix.length + 1);
	if (!payload) {
		return '';
	}

	const target = tryDecodeRelayTarget(payload);
	if (!target) {
		return '';
	}

	const allowDomains = relayConfig.relayTargetDomains;
	if (allowDomains.length > 0) {
		const targetDomain = emailUtils.getDomain(target).toLowerCase();
		if (!allowDomains.includes(targetDomain)) {
			return '';
		}
	}

	return target;
}

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}


		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);

		const relayConfig = getRelayConfig(env);
		const mappedRecipient = resolveRelayRecipient(message.to, relayConfig);
		const receiveTo = mappedRecipient || message.to;
		const isRelayMapped = mappedRecipient !== '';
		const messageToLower = (message.to || '').toLowerCase();

		const account = await accountService.selectByEmailIncludeDel({ env: env }, receiveTo);

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, receiveTo)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: receiveTo, name: emailUtils.getName(receiveTo)}]
		} else {
			email.to = email.to.map(item => {
				if (!item?.address) {
					return item;
				}

				if (item.address.toLowerCase() !== messageToLower) {
					return item;
				}

				return {
					...item,
					address: receiveTo,
					name: item.name || emailUtils.getName(receiveTo)
				};
			});
		}

		const toName = email.to.find(item => item.address?.toLowerCase() === receiveTo.toLowerCase())?.name || '';

		const params = {
			toEmail: receiveTo,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = parseList(ruleEmail);

			if (!emails.includes(receiveTo.toLowerCase())) {
				return;
			}

		}

		//转发到TG
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		//转发到其他邮箱
		if (!isRelayMapped && forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e
	}
}
