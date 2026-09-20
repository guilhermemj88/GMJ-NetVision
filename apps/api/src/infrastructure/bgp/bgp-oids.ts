/** Standard BGP4-MIB peer state table. The IPv4 peer address is the row index. */
export const BGP4_PEER_STATE_OID = '1.3.6.1.2.1.15.3.1.2';

/**
 * HUAWEI-BGP-VPN-MIB received-prefix counter. Its row index includes address
 * family metadata and must never be treated as a plain IPv4 suffix.
 */
export const HUAWEI_BGP_PEER_PREFIX_RECEIVED_OID = '1.3.6.1.4.1.2011.5.25.177.1.1.3.1.1';
