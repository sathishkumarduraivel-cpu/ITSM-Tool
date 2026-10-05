// The default CI class model, seeded per workspace on first read.
//
// It is deliberately a tree rather than a flat list of asset types: a Server
// and a Virtual Machine share "serial number, manufacturer, model" because
// both are Hardware, and every CI in the estate shares "environment,
// criticality, support group" because everything is a Configuration Item.
// Declaring that once, on the ancestor, is what stops a CMDB drifting into
// twenty classes that each spell "OS version" slightly differently.
//
// Everything here is editable after seeding. system=1 only freezes the KEY
// (stored CIs and identification rules reference it) and blocks deletion --
// labels, attributes, requiredness and options all stay an admin decision.

// An abstract class is a grouping node: it carries attributes that descend,
// but no CI can be created directly on it.
export const DEFAULT_CLASSES = [
  { key: 'configuration_item', label: 'Configuration Item', plural_label: 'Configuration Items', parent: null, is_asset: 0, is_abstract: 1, icon: 'box', color: '#64748b',
    description: 'The root of the model. Everything the CMDB tracks is a Configuration Item.' },

  { key: 'hardware', label: 'Hardware', plural_label: 'Hardware', parent: 'configuration_item', is_asset: 1, is_abstract: 1, icon: 'server', color: '#0ea5e9',
    description: 'Physical equipment that is owned, depreciates and carries a warranty.' },
  { key: 'server', label: 'Server', plural_label: 'Servers', parent: 'hardware', is_asset: 1, is_abstract: 0, icon: 'server', color: '#0284c7',
    description: 'A physical or bare-metal compute host.' },
  { key: 'virtual_machine', label: 'Virtual Machine', plural_label: 'Virtual Machines', parent: 'hardware', is_asset: 1, is_abstract: 0, icon: 'layers', color: '#38bdf8',
    description: 'A guest running on a hypervisor host.' },
  { key: 'network_device', label: 'Network Device', plural_label: 'Network Devices', parent: 'hardware', is_asset: 1, is_abstract: 0, icon: 'network', color: '#6366f1',
    description: 'Routers, switches, firewalls, load balancers and access points.' },
  { key: 'storage_device', label: 'Storage', plural_label: 'Storage Devices', parent: 'hardware', is_asset: 1, is_abstract: 0, icon: 'database', color: '#8b5cf6',
    description: 'Arrays, SAN and NAS appliances.' },
  { key: 'endpoint', label: 'Endpoint', plural_label: 'Endpoints', parent: 'hardware', is_asset: 1, is_abstract: 0, icon: 'laptop', color: '#14b8a6',
    description: 'User computing devices: laptops, desktops and workstations.' },
  { key: 'mobile_device', label: 'Mobile Device', plural_label: 'Mobile Devices', parent: 'hardware', is_asset: 1, is_abstract: 0, icon: 'smartphone', color: '#2dd4bf',
    description: 'Phones and tablets, typically enrolled in an MDM.' },
  { key: 'printer', label: 'Printer', plural_label: 'Printers', parent: 'hardware', is_asset: 1, is_abstract: 0, icon: 'printer', color: '#94a3b8',
    description: 'Printers and multifunction devices.' },

  { key: 'software', label: 'Software', plural_label: 'Software', parent: 'configuration_item', is_asset: 0, is_abstract: 1, icon: 'code', color: '#f59e0b',
    description: 'Installed or hosted software. Not an asset in itself -- the entitlement to use it is.' },
  { key: 'application', label: 'Application', plural_label: 'Applications', parent: 'software', is_asset: 0, is_abstract: 0, icon: 'app-window', color: '#f97316',
    description: 'A business application that users log into.' },
  { key: 'database', label: 'Database', plural_label: 'Databases', parent: 'software', is_asset: 0, is_abstract: 0, icon: 'database', color: '#eab308',
    description: 'A database instance or schema.' },
  { key: 'middleware', label: 'Middleware', plural_label: 'Middleware', parent: 'software', is_asset: 0, is_abstract: 0, icon: 'git-merge', color: '#d97706',
    description: 'Queues, caches, API gateways, web and application servers.' },
  { key: 'operating_system', label: 'Operating System', plural_label: 'Operating Systems', parent: 'software', is_asset: 0, is_abstract: 0, icon: 'terminal', color: '#a16207',
    description: 'An OS build, tracked so end-of-support can be reported on.' },
  { key: 'software_product', label: 'Software Product', plural_label: 'Software Products', parent: 'software', is_asset: 1, is_abstract: 0, icon: 'package', color: '#ca8a04',
    description: 'A licensable product. Entitlements and installations are counted against it.' },

  { key: 'service', label: 'Service', plural_label: 'Services', parent: 'configuration_item', is_asset: 0, is_abstract: 1, icon: 'heart-pulse', color: '#ec4899',
    description: 'Something the organisation consumes or delivers, rather than something it owns.' },
  { key: 'business_service', label: 'Business Service', plural_label: 'Business Services', parent: 'service', is_asset: 0, is_abstract: 0, icon: 'briefcase', color: '#db2777',
    description: 'A service the business recognises by name. Impact is ultimately measured here.' },
  { key: 'technical_service', label: 'Technical Service', plural_label: 'Technical Services', parent: 'service', is_asset: 0, is_abstract: 0, icon: 'settings', color: '#be185d',
    description: 'An internal capability that business services are built on.' },

  { key: 'cloud', label: 'Cloud', plural_label: 'Cloud', parent: 'configuration_item', is_asset: 0, is_abstract: 1, icon: 'cloud', color: '#22c55e',
    description: 'Resources billed by a provider rather than purchased.' },
  { key: 'cloud_account', label: 'Cloud Account', plural_label: 'Cloud Accounts', parent: 'cloud', is_asset: 0, is_abstract: 0, icon: 'wallet', color: '#16a34a',
    description: 'A provider account or subscription that resources and spend roll up to.' },
  { key: 'cloud_resource', label: 'Cloud Resource', plural_label: 'Cloud Resources', parent: 'cloud', is_asset: 0, is_abstract: 0, icon: 'cloud-cog', color: '#4ade80',
    description: 'Any discrete provider-managed resource, identified by its provider resource id.' },
  { key: 'container_cluster', label: 'Container Cluster', plural_label: 'Container Clusters', parent: 'cloud', is_asset: 0, is_abstract: 0, icon: 'boxes', color: '#15803d',
    description: 'A Kubernetes or equivalent orchestration cluster.' },

  { key: 'facility', label: 'Facility', plural_label: 'Facilities', parent: 'configuration_item', is_asset: 0, is_abstract: 1, icon: 'building', color: '#78716c',
    description: 'Physical locations that equipment lives in.' },
  { key: 'data_center', label: 'Data Centre', plural_label: 'Data Centres', parent: 'facility', is_asset: 0, is_abstract: 0, icon: 'building-2', color: '#57534e',
    description: 'An owned or colocated site.' },
  { key: 'rack', label: 'Rack', plural_label: 'Racks', parent: 'facility', is_asset: 1, is_abstract: 0, icon: 'rows-3', color: '#a8a29e',
    description: 'A cabinet within a data centre, with its own capacity and power draw.' },
];

// Attributes are declared against the class that OWNS them; every descendant
// inherits them. A child may redeclare a parent attr_key to tighten it --
// cloud_account does exactly that to account_identifier, turning an optional
// inherited field into a required identifier.
export const DEFAULT_ATTRIBUTES = {
  configuration_item: [
    { attr_key: 'environment', label: 'Environment', data_type: 'select', options: ['production', 'staging', 'test', 'development', 'dr'], help_text: 'Production CIs are scored harder by change risk.' },
    { attr_key: 'business_criticality', label: 'Business criticality', data_type: 'select', options: ['critical', 'high', 'medium', 'low'], default_value: 'medium' },
    { attr_key: 'support_group', label: 'Support group', data_type: 'text', help_text: 'Who is accountable when this breaks.' },
    { attr_key: 'managed_by', label: 'Managed by', data_type: 'text' },
    { attr_key: 'ci_description', label: 'Description', data_type: 'textarea' },
    { attr_key: 'compliance_scope', label: 'Compliance scope', data_type: 'multiselect', options: ['pci_dss', 'hipaa', 'gdpr', 'sox', 'iso_27001', 'nis2'] },
    { attr_key: 'last_seen_at', label: 'Last seen', data_type: 'datetime', help_text: 'Set by discovery. Drives the staleness half of the CMDB health score.' },
  ],

  hardware: [
    { attr_key: 'serial_number', label: 'Serial number', data_type: 'text', is_identifier: 1, help_text: 'The most reliable identifier a physical device has.' },
    { attr_key: 'manufacturer', label: 'Manufacturer', data_type: 'text' },
    { attr_key: 'model', label: 'Model', data_type: 'text' },
    { attr_key: 'installed_rack', label: 'Rack', data_type: 'reference', reference_class: 'rack' },
    { attr_key: 'rack_position', label: 'Rack position (U)', data_type: 'integer', min_value: 1, max_value: 60 },
    { attr_key: 'power_draw_watts', label: 'Power draw', data_type: 'number', unit: 'W', min_value: 0 },
  ],
  server: [
    { attr_key: 'hostname', label: 'Hostname', data_type: 'text', required: 1, is_identifier: 1 },
    { attr_key: 'fqdn', label: 'FQDN', data_type: 'text' },
    { attr_key: 'ip_address', label: 'IP address', data_type: 'ip', is_identifier: 1 },
    { attr_key: 'operating_system', label: 'Operating system', data_type: 'text' },
    { attr_key: 'os_version', label: 'OS version', data_type: 'text' },
    { attr_key: 'cpu_cores', label: 'CPU cores', data_type: 'integer', min_value: 1, max_value: 4096 },
    { attr_key: 'memory_gb', label: 'Memory', data_type: 'number', unit: 'GB', min_value: 0 },
    { attr_key: 'storage_gb', label: 'Storage', data_type: 'number', unit: 'GB', min_value: 0 },
    { attr_key: 'cluster_name', label: 'Cluster', data_type: 'text' },
  ],
  virtual_machine: [
    { attr_key: 'hostname', label: 'Hostname', data_type: 'text', required: 1, is_identifier: 1 },
    { attr_key: 'ip_address', label: 'IP address', data_type: 'ip', is_identifier: 1 },
    { attr_key: 'hypervisor_host', label: 'Hypervisor host', data_type: 'reference', reference_class: 'server', help_text: 'Which physical host it runs on. Feeds impact analysis.' },
    { attr_key: 'vcpu', label: 'vCPU', data_type: 'integer', min_value: 1 },
    { attr_key: 'memory_gb', label: 'Memory', data_type: 'number', unit: 'GB', min_value: 0 },
    { attr_key: 'guest_os', label: 'Guest OS', data_type: 'text' },
  ],
  network_device: [
    { attr_key: 'management_ip', label: 'Management IP', data_type: 'ip', required: 1, is_identifier: 1 },
    { attr_key: 'device_role', label: 'Role', data_type: 'select', required: 1, options: ['router', 'switch', 'firewall', 'load_balancer', 'wireless_ap', 'vpn_gateway'] },
    { attr_key: 'firmware_version', label: 'Firmware version', data_type: 'text' },
    { attr_key: 'port_count', label: 'Ports', data_type: 'integer', min_value: 1 },
    { attr_key: 'vlan_ids', label: 'VLANs', data_type: 'text' },
  ],
  storage_device: [
    { attr_key: 'capacity_tb', label: 'Capacity', data_type: 'number', unit: 'TB', min_value: 0 },
    { attr_key: 'used_tb', label: 'Used', data_type: 'number', unit: 'TB', min_value: 0 },
    { attr_key: 'storage_protocol', label: 'Protocol', data_type: 'select', options: ['iscsi', 'fibre_channel', 'nfs', 'smb', 'object'] },
    { attr_key: 'raid_level', label: 'RAID level', data_type: 'text' },
  ],
  endpoint: [
    { attr_key: 'hostname', label: 'Hostname', data_type: 'text', is_identifier: 1 },
    { attr_key: 'form_factor', label: 'Form factor', data_type: 'select', options: ['laptop', 'desktop', 'workstation', 'thin_client'] },
    { attr_key: 'operating_system', label: 'Operating system', data_type: 'text' },
    { attr_key: 'os_version', label: 'OS version', data_type: 'text' },
    { attr_key: 'disk_encrypted', label: 'Disk encrypted', data_type: 'boolean' },
    { attr_key: 'last_patched_at', label: 'Last patched', data_type: 'date' },
  ],
  mobile_device: [
    { attr_key: 'imei', label: 'IMEI', data_type: 'text', is_identifier: 1 },
    { attr_key: 'platform', label: 'Platform', data_type: 'select', options: ['ios', 'android', 'other'] },
    { attr_key: 'os_version', label: 'OS version', data_type: 'text' },
    { attr_key: 'mdm_enrolled', label: 'MDM enrolled', data_type: 'boolean' },
    { attr_key: 'phone_number', label: 'Phone number', data_type: 'text' },
  ],
  printer: [
    { attr_key: 'ip_address', label: 'IP address', data_type: 'ip', is_identifier: 1 },
    { attr_key: 'printer_type', label: 'Type', data_type: 'select', options: ['laser', 'inkjet', 'label', 'mfp'] },
    { attr_key: 'monthly_volume', label: 'Monthly volume', data_type: 'integer', unit: 'pages', min_value: 0 },
  ],

  software: [
    { attr_key: 'version', label: 'Version', data_type: 'text' },
    { attr_key: 'publisher', label: 'Publisher', data_type: 'text' },
    { attr_key: 'end_of_support', label: 'End of support', data_type: 'date', help_text: 'Drives the end-of-life report and a change risk signal.' },
  ],
  application: [
    { attr_key: 'app_code', label: 'Application code', data_type: 'text', required: 1, is_identifier: 1, help_text: 'The short code the business knows it by.' },
    { attr_key: 'app_url', label: 'URL', data_type: 'url' },
    { attr_key: 'data_classification', label: 'Data classification', data_type: 'select', required: 1, options: ['public', 'internal', 'confidential', 'restricted'] },
    { attr_key: 'business_owner', label: 'Business owner', data_type: 'text' },
    { attr_key: 'technical_owner', label: 'Technical owner', data_type: 'text' },
    { attr_key: 'tech_stack', label: 'Technology stack', data_type: 'text' },
    { attr_key: 'user_count', label: 'Users', data_type: 'integer', min_value: 0 },
    { attr_key: 'authentication_method', label: 'Authentication', data_type: 'select', options: ['sso_saml', 'oidc', 'ldap', 'local', 'none'] },
  ],
  database: [
    { attr_key: 'instance_name', label: 'Instance name', data_type: 'text', required: 1, is_identifier: 1 },
    { attr_key: 'db_engine', label: 'Engine', data_type: 'select', required: 1, options: ['postgresql', 'mysql', 'mariadb', 'oracle', 'sql_server', 'mongodb', 'redis', 'elasticsearch', 'other'] },
    { attr_key: 'db_port', label: 'Port', data_type: 'integer', min_value: 1, max_value: 65535 },
    { attr_key: 'size_gb', label: 'Size', data_type: 'number', unit: 'GB', min_value: 0 },
    { attr_key: 'ha_enabled', label: 'High availability', data_type: 'boolean' },
    { attr_key: 'backup_schedule', label: 'Backup schedule', data_type: 'text' },
    { attr_key: 'contains_pii', label: 'Contains personal data', data_type: 'boolean' },
  ],
  middleware: [
    { attr_key: 'middleware_type', label: 'Type', data_type: 'select', options: ['message_queue', 'app_server', 'web_server', 'api_gateway', 'cache', 'etl'] },
    { attr_key: 'endpoint_url', label: 'Endpoint', data_type: 'url' },
  ],
  operating_system: [
    { attr_key: 'os_family', label: 'Family', data_type: 'select', required: 1, options: ['windows', 'linux', 'macos', 'unix', 'other'] },
    { attr_key: 'build_version', label: 'Build', data_type: 'text', is_identifier: 1 },
  ],
  software_product: [
    { attr_key: 'product_name', label: 'Product name', data_type: 'text', required: 1, is_identifier: 1 },
    { attr_key: 'edition', label: 'Edition', data_type: 'text' },
    { attr_key: 'licensing_metric', label: 'Licensing metric', data_type: 'select', required: 1, options: ['per_device', 'per_user', 'per_core', 'per_socket', 'concurrent', 'subscription', 'free'], help_text: 'How entitlements are counted against installations.' },
  ],

  service: [
    { attr_key: 'service_owner', label: 'Service owner', data_type: 'text' },
    { attr_key: 'business_unit', label: 'Business unit', data_type: 'text' },
    { attr_key: 'service_hours', label: 'Service hours', data_type: 'text' },
  ],
  business_service: [
    { attr_key: 'sla_tier', label: 'SLA tier', data_type: 'select', required: 1, options: ['platinum', 'gold', 'silver', 'bronze'] },
    { attr_key: 'users_affected', label: 'Users served', data_type: 'integer', min_value: 0 },
    { attr_key: 'rto_hours', label: 'RTO', data_type: 'number', unit: 'hours', min_value: 0 },
    { attr_key: 'rpo_hours', label: 'RPO', data_type: 'number', unit: 'hours', min_value: 0 },
    { attr_key: 'availability_target', label: 'Availability target', data_type: 'number', unit: '%', min_value: 0, max_value: 100 },
    { attr_key: 'revenue_impact_per_hour', label: 'Revenue impact per hour', data_type: 'number', min_value: 0, help_text: 'Puts a number on an outage rather than a colour.' },
    { attr_key: 'customer_facing', label: 'Customer facing', data_type: 'boolean' },
  ],
  technical_service: [
    { attr_key: 'service_type', label: 'Type', data_type: 'select', options: ['infrastructure', 'platform', 'application', 'network', 'security'] },
    { attr_key: 'supports_service', label: 'Supports', data_type: 'reference', reference_class: 'business_service' },
  ],

  cloud: [
    { attr_key: 'cloud_provider', label: 'Provider', data_type: 'select', required: 1, options: ['aws', 'azure', 'gcp', 'oci', 'alibaba', 'other'] },
    { attr_key: 'region', label: 'Region', data_type: 'text' },
    { attr_key: 'account_identifier', label: 'Account identifier', data_type: 'text' },
  ],
  cloud_account: [
    // Tightens the inherited attribute: on an account itself, the account
    // identifier is the thing that identifies it.
    { attr_key: 'account_identifier', label: 'Account identifier', data_type: 'text', required: 1, is_identifier: 1 },
    { attr_key: 'billing_owner', label: 'Billing owner', data_type: 'text' },
    { attr_key: 'monthly_spend', label: 'Monthly spend', data_type: 'number', min_value: 0 },
  ],
  cloud_resource: [
    { attr_key: 'resource_id', label: 'Resource id', data_type: 'text', required: 1, is_identifier: 1 },
    { attr_key: 'resource_type', label: 'Resource type', data_type: 'text', required: 1 },
    { attr_key: 'owning_account', label: 'Cloud account', data_type: 'reference', reference_class: 'cloud_account' },
    { attr_key: 'monthly_cost', label: 'Monthly cost', data_type: 'number', min_value: 0 },
    { attr_key: 'provider_tags', label: 'Provider tags', data_type: 'textarea', help_text: 'As reported by the provider.' },
  ],
  container_cluster: [
    { attr_key: 'cluster_name', label: 'Cluster name', data_type: 'text', required: 1, is_identifier: 1 },
    { attr_key: 'orchestrator', label: 'Orchestrator', data_type: 'select', options: ['kubernetes', 'openshift', 'eks', 'aks', 'gke', 'ecs', 'nomad'] },
    { attr_key: 'node_count', label: 'Nodes', data_type: 'integer', min_value: 0 },
    { attr_key: 'orchestrator_version', label: 'Version', data_type: 'text' },
  ],

  facility: [
    { attr_key: 'site_code', label: 'Site code', data_type: 'text', is_identifier: 1 },
    { attr_key: 'address', label: 'Address', data_type: 'textarea' },
  ],
  data_center: [
    { attr_key: 'dc_tier', label: 'Tier', data_type: 'select', options: ['tier_i', 'tier_ii', 'tier_iii', 'tier_iv'] },
    { attr_key: 'floor_space_sqm', label: 'Floor space', data_type: 'number', unit: 'sqm', min_value: 0 },
    { attr_key: 'power_capacity_kw', label: 'Power capacity', data_type: 'number', unit: 'kW', min_value: 0 },
  ],
  rack: [
    { attr_key: 'rack_units', label: 'Rack units', data_type: 'integer', default_value: '42', min_value: 1, max_value: 60 },
    { attr_key: 'used_units', label: 'Used units', data_type: 'integer', min_value: 0, max_value: 60 },
    { attr_key: 'parent_data_center', label: 'Data centre', data_type: 'reference', reference_class: 'data_center' },
    { attr_key: 'power_draw_kw', label: 'Power draw', data_type: 'number', unit: 'kW', min_value: 0 },
  ],
};

// The legacy assets.type values, mapped onto the new model so an estate that
// predates classes reads correctly without a backfill.
export const LEGACY_TYPE_TO_CLASS = {
  hardware: 'endpoint',
  software: 'application',
  license: 'software_product',
  service: 'business_service',
};
