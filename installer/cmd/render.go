// Copyright (c) 2021 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License-AGPL.txt in the project root for license information.

package cmd

import (
	"fmt"
	"os"

	_ "embed"

	"github.com/gitpod-io/gitpod/installer/pkg/common"
	"github.com/gitpod-io/gitpod/installer/pkg/components"
	"github.com/gitpod-io/gitpod/installer/pkg/config"
	configv1 "github.com/gitpod-io/gitpod/installer/pkg/config/v1"
	"github.com/spf13/cobra"
	"sigs.k8s.io/yaml"
)

var renderOpts struct {
	ConfigFN               string
	Namespace              string
	ValidateConfigDisabled bool
}

// renderCmd represents the render command
var renderCmd = &cobra.Command{
	Use:   "render",
	Short: "Renders the Kubernetes manifests required to install Gitpod",
	Long: `Renders the Kubernetes manifests required to install Gitpod

A config file is required which can be generated with the init command.`,
	Example: `  # Default install.
  gitpod-installer render --config config.yaml | kubectl apply -f -

  # Install Gitpod into a non-default namespace.
  gitpod-installer render --config config.yaml --namespace gitpod | kubectl apply -f -`,
	RunE: func(cmd *cobra.Command, args []string) error {
		_, cfgVersion, cfg, err := loadConfig(renderOpts.ConfigFN)
		if err != nil {
			return err
		}

		versionMF, err := getVersionManifest()
		if err != nil {
			return err
		}

		if !renderOpts.ValidateConfigDisabled {
			apiVersion, err := config.LoadConfigVersion(cfgVersion)
			if err != nil {
				return err
			}
			res, err := config.Validate(apiVersion, cfg)
			if err != nil {
				return err
			}

			if !res.Valid {
				res.Marshal(os.Stderr)
				fmt.Fprintln(os.Stderr, "configuration is invalid")
				os.Exit(1)
			}
		}

		ctx, err := common.NewRenderContext(*cfg, *versionMF, renderOpts.Namespace)
		if err != nil {
			return err
		}

		var renderable common.RenderFunc
		var helmCharts common.HelmFunc
		switch cfg.Kind {
		case configv1.InstallationFull:
			renderable = components.FullObjects
			helmCharts = components.FullHelmDependencies
		case configv1.InstallationMeta:
			renderable = components.MetaObjects
			helmCharts = components.MetaHelmDependencies
		case configv1.InstallationWorkspace:
			renderable = components.WorkspaceObjects
			helmCharts = components.WorkspaceHelmDependencies
		default:
			return fmt.Errorf("unsupported installation kind: %s", cfg.Kind)
		}

		objs, err := common.CompositeRenderFunc(components.CommonObjects, renderable)(ctx)
		if err != nil {
			return err
		}

		k8s := make([]string, 0)
		for _, o := range objs {
			fc, err := yaml.Marshal(o)
			if err != nil {
				return err
			}

			k8s = append(k8s, fmt.Sprintf("---\n%s\n", string(fc)))
		}

		charts, err := common.CompositeHelmFunc(components.CommonHelmDependencies, helmCharts)(ctx)
		if err != nil {
			return err
		}
		k8s = append(k8s, charts...)

		// convert everything to individual objects
		runtimeObjs, err := common.YamlToRuntimeObject(k8s)
		if err != nil {
			return err
		}

		// generate a config map with every component installed
		runtimeObjsAndConfig, err := common.GenerateInstallationConfigMap(ctx, runtimeObjs)
		if err != nil {
			return err
		}

		// sort the objects and return the plain YAML
		sortedObjs, err := common.DependencySortingRenderFunc(runtimeObjsAndConfig)
		if err != nil {
			return err
		}

		// output the YAML to stdout
		for _, c := range sortedObjs {
			fmt.Printf("---\n# %s/%s %s\n%s\n", c.TypeMeta.APIVersion, c.TypeMeta.Kind, c.Metadata.Name, c.Content)
		}

		return nil
	},
}

func loadConfig(cfgFN string) (rawCfg interface{}, cfgVersion string, cfg *configv1.Config, err error) {
	rawCfg, cfgVersion, err = config.Load(cfgFN)
	if err != nil {
		err = fmt.Errorf("error loading config: %w", err)
		return
	}
	if cfgVersion != config.CurrentVersion {
		err = fmt.Errorf("config version is mismatch: expected %s, got %s", config.CurrentVersion, cfgVersion)
		return
	}
	cfg = rawCfg.(*configv1.Config)

	return rawCfg, cfgVersion, cfg, err
}

func init() {
	rootCmd.AddCommand(renderCmd)

	renderCmd.PersistentFlags().StringVarP(&renderOpts.ConfigFN, "config", "c", os.Getenv("GITPOD_INSTALLER_CONFIG"), "path to the config file")
	renderCmd.PersistentFlags().StringVarP(&renderOpts.Namespace, "namespace", "n", "default", "namespace to deploy to")
	renderCmd.Flags().BoolVar(&renderOpts.ValidateConfigDisabled, "no-validation", false, "if set, the config will not be validated before running")
}
